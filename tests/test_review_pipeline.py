import asyncio
import shutil

import pytest
from fastapi import HTTPException

from app import config, main
from app.github_client import RepoSnapshot
from app.reviewer import prepare_analysis
from app.schemas import ReviewRequest


def make_snapshot():
    return RepoSnapshot(
        owner="example",
        name="project",
        branch="main",
        description="A small sample repository",
        homepage="",
        stars=0,
        pushed_at="",
        primary_language="Python",
        tree=["README.md", "main.py", "requirements.txt"],
        tree_truncated=False,
        files={
            "README.md": "A sample repository.",
            "main.py": "print('hello')",
            "requirements.txt": "fastapi\n",
        },
    )


@pytest.mark.parametrize("role_id", ["fde", "data_scientist", "swe", "nlp"])
def test_same_repository_uses_the_selected_role_skill_scope(monkeypatch, role_id):
    async def fake_fetch(_url):
        return make_snapshot()

    monkeypatch.setattr("app.reviewer.fetch_snapshot", fake_fetch)
    result = asyncio.run(prepare_analysis("https://github.com/example/project", role_id))
    configured_role = next(role for role in main.load_roles() if role["id"] == role_id)

    assert result["role"]["id"] == role_id
    assert {row["id"] for row in result["matrix"]} == set(configured_role["skill_weights"])
    assert all(row["total_postings"] == 0 and row["pct"] is None for row in result["matrix"])


def test_sample_only_review_has_no_market_based_score_inputs_or_findings(monkeypatch):
    async def fake_fetch(_url):
        return make_snapshot()

    async def unexpected_llm_call(*_args):
        raise AssertionError("LLM must not produce a market summary without real postings")

    monkeypatch.setattr("app.reviewer.fetch_snapshot", fake_fetch)
    monkeypatch.setattr("app.reviewer.llm.complete_json", unexpected_llm_call)
    monkeypatch.setattr(config, "LLM_PROVIDER", "mock")
    result = asyncio.run(
        main.review(ReviewRequest(repo_url="https://github.com/example/project", role="swe"))
    )

    assert result["postings"]["using_sample_postings"]
    assert result["postings"]["evidence_count"] == 0
    assert result["postings"]["sample_count"] > 0
    assert all(row["status"] == "market_unavailable" for row in result["skill_matrix"])
    assert all(row["pct"] is None for row in result["skill_matrix"])
    assert "market demand could not be assessed" in result["critique"]["summary"]
    assert not any(
        finding["title"].startswith("No repository evidence found")
        for finding in result["critique"]["findings"]
    )


def test_review_with_no_postings_returns_clear_client_error(monkeypatch, tmp_path):
    shutil.copyfile(config.DATA_DIR / "roles.json", tmp_path / "roles.json")
    (tmp_path / "postings" / "swe").mkdir(parents=True)
    monkeypatch.setattr(config, "DATA_DIR", tmp_path)

    with pytest.raises(HTTPException) as error:
        asyncio.run(main.review(
            ReviewRequest(repo_url="https://github.com/example/project", role="swe")
        ))

    assert error.value.status_code == 400
    assert "No job postings found for this role" in error.value.detail


def test_review_with_real_posting_produces_market_data_and_supported_gap(monkeypatch):
    async def fake_fetch(_url):
        return make_snapshot()

    monkeypatch.setattr("app.reviewer.fetch_snapshot", fake_fetch)
    monkeypatch.setattr(config, "LLM_PROVIDER", "mock")
    posting = (
        "Software Engineer: Python, REST APIs, SQL, unit tests, automated testing, "
        "continuous integration, Docker, cloud deployment, and logging."
    )
    result = asyncio.run(main.review(ReviewRequest(
        repo_url="https://github.com/example/project",
        role="swe",
        pasted_postings=[posting],
    )))

    assert result["postings"]["evidence_count"] == 1
    assert result["postings"]["sample_count"] == 0
    assert all(row["total_postings"] == 1 for row in result["skill_matrix"])
    testing = next(row for row in result["skill_matrix"] if row["id"] == "testing")
    assert testing["postings_mentioning"] == 1
    assert testing["pct"] == 1.0
    assert testing["status"] == "gap"
    assert any(
        finding["title"] == "No repository evidence found for Automated testing"
        for finding in result["critique"]["findings"]
    )
    expected_gap_count = sum(row["status"] == "gap" for row in result["skill_matrix"])
    assert f"{expected_gap_count} in-demand skill(s)" in result["critique"]["summary"]


def test_real_postings_without_role_skill_matches_do_not_claim_zero_market_gaps(monkeypatch):
    async def fake_fetch(_url):
        return make_snapshot()

    async def unexpected_llm_call(*_args):
        raise AssertionError("LLM must not infer role demand when no configured skills matched")

    monkeypatch.setattr("app.reviewer.fetch_snapshot", fake_fetch)
    monkeypatch.setattr("app.reviewer.llm.complete_json", unexpected_llm_call)
    result = asyncio.run(main.review(ReviewRequest(
        repo_url="https://github.com/example/project",
        role="swe",
        pasted_postings=["Seeking a curious person for a collaborative and exciting opportunity."],
    )))

    assert result["postings"]["evidence_count"] == 1
    assert all(row["postings_mentioning"] == 0 for row in result["skill_matrix"])
    assert "none matched the configured role skills" in result["critique"]["summary"]
    assert result["critique"]["source"] == "rule-based (no matched role skills)"
    assert not any(
        finding["title"].startswith("No repository evidence found")
        for finding in result["critique"]["findings"]
    )
