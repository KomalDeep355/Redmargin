"""A deterministic project-evidence verdict with validated, evidence-backed bullets."""
from __future__ import annotations

import re

from . import llm, prompts
from .github_client import RepoSnapshot
from .reviewer import is_valid_evidence

_NUMBER_RE = re.compile(r"\b\d+(?:\.\d+)?%?")
_UNSUPPORTED_CLAIM_RE = re.compile(
    r"\b(?:years?\s+of\s+experience|managed|led|increased|improved|boosted|reduced|achieved|"
    r"grew|delivered|launched|optimized|streamlined|transformed|saved|scaled|deployed|"
    r"secured|productionized|accelerated)\b",
    re.I,
)
_STOP_WORDS = {
    "about", "across", "and", "based", "built", "by", "for", "from", "in", "into",
    "its", "project", "repo", "repository", "the", "through", "to", "using", "with",
    "developed", "implemented", "created", "engineered", "designed",
}


def _fallback_bullets(snap: RepoSnapshot) -> list[dict]:
    language = snap.primary_language or "software"
    source_extensions = {
        ".py", ".js", ".ts", ".tsx", ".jsx", ".java", ".go", ".rs", ".cpp", ".c",
        ".cs", ".rb", ".php", ".kt", ".swift",
    }
    source_paths = [
        path for path in snap.files
        if "." in path.rsplit("/", 1)[-1]
        and "." + path.rsplit(".", 1)[-1].lower() in source_extensions
        and snap.files[path].strip()
    ]
    return [
        {
            "text": f"Built a {language} project with implementation in `{path}`.",
            "evidence": [path],
        }
        for path in source_paths[:3]
    ]


def _validate_bullets(raw_bullets, snap: RepoSnapshot) -> tuple[list[dict], int]:
    if raw_bullets is None:
        return [], 0
    if not isinstance(raw_bullets, list):
        return [], 1

    valid = []
    rejected = 0
    for item in raw_bullets:
        if not isinstance(item, dict):
            rejected += 1
            continue
        text = item.get("text")
        evidence = item.get("evidence")
        if not isinstance(text, str) or not text.strip() or not isinstance(evidence, list):
            rejected += 1
            continue
        cited = list(dict.fromkeys(
            path for path in evidence
            if isinstance(path, str)
            and path in snap.files
            and is_valid_evidence(path, set(snap.tree), set(), set())
        ))
        if not cited:
            rejected += 1
            continue

        cited_text = "\n".join(snap.files[path] for path in cited).casefold()
        normalized = text.strip()
        numbers = _NUMBER_RE.findall(normalized)
        if (
            _UNSUPPORTED_CLAIM_RE.search(normalized)
            or any(number.casefold() not in cited_text for number in numbers)
        ):
            rejected += 1
            continue

        terms = {
            token.casefold()
            for token in re.findall(r"[A-Za-z][A-Za-z0-9+#.-]{3,}", normalized)
            if token.casefold() not in _STOP_WORDS
        }
        cited_terms = set(re.findall(r"[A-Za-z][A-Za-z0-9+#.-]{3,}", cited_text))
        grounded_terms = terms.intersection(cited_terms)
        if (
            len(terms) < 2
            or len(grounded_terms) < 2
            or len(grounded_terms) / len(terms) < 0.6
        ):
            rejected += 1
            continue
        valid.append({"text": normalized, "evidence": cited})
    return valid[:3], rejected + max(0, len(valid) - 3)


def _deterministic_verdict(signals: dict, matrix: list[dict], snap: RepoSnapshot) -> tuple[str, str]:
    strengths = sum(row["status"] == "strength" for row in matrix)
    gaps = sum(row["status"] == "gap" for row in matrix)
    insufficient_market = any(
        row.get("market_status") == "insufficient_market_data" for row in matrix
    )
    if strengths and strengths >= gaps and signals.get("has_readme") and signals["has_readme"].value:
        verdict = "strong_project_evidence"
    elif snap.files:
        verdict = "developing_project_evidence"
    else:
        verdict = "limited_project_evidence"
    if insufficient_market:
        evidence_count = sum(
            row.get("evidence_status") == "evidence_found" for row in matrix
        )
        explanation = (
            f"The inspected repository shows evidence for {evidence_count} detectable role skill(s). "
            "The market comparison is not assessed because fewer than 10 real postings were available. "
            "This describes repository evidence only; it is not a verdict on the candidate."
        )
    else:
        explanation = (
            f"The inspected repository shows evidence for {strengths} role skills and no matching repository evidence "
            f"for {gaps} high-demand skill(s). "
            "This describes repository evidence only; it is not a verdict on the candidate."
        )
    return verdict, explanation


async def resume_verdict(
    snap: RepoSnapshot,
    role_label: str,
    signals: dict,
    matrix: list[dict],
) -> dict:
    verdict, explanation = _deterministic_verdict(signals, matrix, snap)
    source = "llm"
    llm_error = None
    try:
        raw = await llm.complete_json(
            prompts.RESUME_SYSTEM,
            prompts.build_resume_user(snap, role_label, matrix),
        )
    except llm.LLMError as exc:
        raw = None
        llm_error = str(exc)

    if raw is None:
        source = "rule-based (no LLM configured)" if llm_error is None else "rule-based (LLM failed)"
        bullets = _fallback_bullets(snap)
        rejected = 0
    else:
        bullets, rejected = _validate_bullets(raw.get("bullets"), snap)
        if not bullets:
            bullets = _fallback_bullets(snap)
            source = "rule-based (LLM returned no valid bullets)"
    return {
        "verdict": verdict,
        "explanation": explanation,
        "bullets": bullets,
        "rejected_bullets": rejected,
        "source": source,
        "llm_error": llm_error,
    }
