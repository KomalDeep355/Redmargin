# Repo Reviewer (working name — rename freely)

An honest reviewer for your GitHub projects. You give it a repo and a target role; it compares the repo with what
real job postings ask for, shows where repository evidence was not found, and gives a ranked fix plan with a
day-by-day timetable. Missing repository evidence is not proof that a candidate lacks a skill.

**Design rule:** numbers are deterministic (signals, percentages, hours). The LLM only writes the critique, and every
claim must cite evidence we can check. Unsupported claims are dropped and counted, which gives you a measurable
"how often did the model invent things" number for your write-up.

## Run it (Windows PowerShell)

```powershell
cd D:\Projects\repo-reviewer
py -m venv .venv
.venv\Scripts\Activate.ps1        # if blocked: Set-ExecutionPolicy -Scope Process Bypass
pip install -r requirements.txt
copy .env.example .env             # then edit .env
uvicorn app.main:app --reload
```

Open http://127.0.0.1:8000. Run tests with `python -m pytest`.

## Deploy on Render

The root `render.yaml` defines a Python web service using `app.main:app` and `/api/health`. Create a Blueprint
from this repository, then set `GITHUB_TOKEN` privately in the Render dashboard if you need a higher GitHub API
rate limit. The service defaults to `LLM_PROVIDER=mock`; configure an OpenAI-compatible provider and its matching
base URL, model, and API key in the dashboard only if you want model-generated content.

The default `LLM_PROVIDER=mock` needs no key: review uses a rule-based critique, while interview and resume
features use evidence-only fallbacks and judging returns a deterministic estimate.
For model-generated content set `LLM_PROVIDER=openai_compat` and configure an OpenAI-compatible endpoint
(for example local Ollama or Groq; see `.env.example`).
Add a `GITHUB_TOKEN` to avoid GitHub's low anonymous rate limit (about 60 calls/hour).
Numeric settings with invalid or out-of-range values are logged and use their defaults. `MAX_PASTED_POSTINGS_CHARS`
limits the combined pasted job-description text, and `MAX_REPO_URL_CHARS` limits the repository URL input.
Repository tree size, fetched-file count, GitHub concurrency, and repository text passed to prompts also have
configurable limits. Resource limits have upper bounds even if environment settings are set too high. Repository
URLs must be HTTPS links directly to `github.com/owner/repository`.

## Important before you trust any output

- `data/postings/*/sample-*.txt` are **synthetic test data**. The UI warns you while they are in use. Replace them with
  10–15 real postings per role (or paste postings in the form, separated by a line with `---`).
- Synthetic postings are disclosed but excluded from role-skill market percentages.
- Skill findings describe detectable evidence in the inspected repository only; skills such as customer communication
  that cannot be inferred from source are marked not assessed.
- Fix hours in `data/fix_library.json` are rough defaults, not predictions. Edit them to match your experience.
- Only public repos work for now.

## Structure

```
app/
  main.py            FastAPI routes and health checks
  config.py          settings from .env
  schemas.py         bounded API request and response models
  github_client.py   fetch repo tree + key files via GitHub API (no clone)
  signals.py         deterministic checks: tests, CI, Docker, README metrics, committed .env ...
  skills.py          skill matrix: % of postings mentioning a skill vs evidence in the repo
  postings.py        loads stored/pasted job postings, flags sample data
  planner.py         gaps + hygiene -> ranked fixes -> timetable
  llm.py             OpenAI-compatible client (Ollama, Groq, ...) + mock mode
  prompts.py         all prompt text
  reviewer.py        pipeline + evidence validation + rule-based fallback
  interview.py       repository-grounded interview questions
  resume_verdict.py  deterministic verdict + evidence-checked bullets
  judge.py           weighted hackathon estimate (3 model runs when configured)
data/
  skills.json        skill taxonomy: synonyms in postings, markers in repos, linked fix
  fix_library.json   fixes with hour ranges and steps
  roles.json         target roles
  postings/<role>/   .txt job postings
static/              index.html, style.css, app.js
tests/test_core.py
```

## How to extend

- **New skill:** add an entry to `data/skills.json` (synonyms to find it in postings; manifest-aware dependency,
  path, keyword, or signal markers to find it in repos). Path regexes and taxonomy fields are validated when loaded.
- **New repo check:** add one `_add(...)` line in `signals.py`; add a row to `HYGIENE` in `planner.py` if it should
  produce a fix.
- **New fix:** add it to `data/fix_library.json` and point a skill's `fix_id` at it.
- **New role:** add it to `data/roles.json` and create `data/postings/<id>/`.
- **Evidence-backed features:** interview and resume outputs validate citations against readable repository files.
  The judge endpoint reports estimates and uses a deterministic evidence heuristic when model generation is off or fails.

## Future work

Partner job-data providers should be implemented in a separate integration layer. Evaluation could hand-label real
gaps in ~10 repos and report how often the reviewer finds them.
