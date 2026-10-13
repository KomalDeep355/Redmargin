const $ = (id) => document.getElementById(id);
const esc = (s) => String(s ?? "").replace(/[&<>"']/g, (c) => ({ "&": "&amp;", "<": "&lt;", ">": "&gt;", '"': "&quot;", "'": "&#39;" }[c]));

async function loadRoles() {
  try {
    const response = await fetch("/api/roles");
    if (!response.ok) throw new Error("Role request failed");
    const roles = await response.json();
    $("role").innerHTML = roles.map((r) => `<option value="${esc(r.id)}">${esc(r.label)}</option>`).join("");
  } catch {
    $("role").innerHTML = '<option value="">Roles unavailable</option>';
    setStatus("Could not load roles. Check that the server is running, then refresh.", true);
  }
}

function setStatus(msg, isError = false) {
  $("status").textContent = msg;
  $("status").className = isError ? "status-line error" : "status-line";
}

function chips(list) {
  return `<div class="chips">${(list || []).map((e) => `<span class="chip">${esc(e)}</span>`).join("")}</div>`;
}

function renderMatrix(rows) {
  const head = `<div class="g-row g-head" role="row"><span>SKILL / REQUIREMENT</span><span>SHARE OF POSTINGS</span><span>IN REPO?</span><span>RECEIPTS</span></div>`;
  const body = (rows || []).map((r) => {
    const pct = Math.max(0, Math.min(100, Math.round(Number(r.pct || 0) * 100)));
    let mark = '<span class="mark no" title="No evidence found in the inspected repository" aria-label="No evidence found">✕</span>';
    if (!r.detectable) mark = '<span class="mark na" title="Cannot be judged from code alone" aria-label="Needs human review">CHECK</span>';
    else if (r.in_repo) mark = '<span class="mark yes" title="Evidence found" aria-label="Evidence found">✓</span>';
    const evidence = r.detectable ? ((r.evidence || []).join(", ") || "No matching evidence found") : "Review the write-up or demo manually";
    return `<div class="g-row" role="row">
      <span>${esc(r.label)}</span>
      <span><div class="bar" aria-label="${pct}% of postings mention this skill"><span style="width:${pct}%"></span></div><span class="bar-label">${esc(r.postings_mentioning ?? 0)} of ${esc(r.total_postings ?? 0)} postings · ${pct}%</span></span>
      <span>${mark}</span>
      <span class="ev">${esc(evidence)}</span>
    </div>`;
  }).join("");
  $("matrix").innerHTML = head + (body || '<div class="g-row"><span>No skill comparisons were returned for this review.</span></div>');
}

function renderNotes(items, cls) {
  return (items || []).map((f) => `<article class="note ${cls}">
      <h3>${esc(f.title || "Review note")}</h3>
      ${f.detail ? `<p>${esc(f.detail)}</p>` : ""}
      ${chips(f.evidence)}
    </article>`).join("");
}

function renderPlan(plan) {
  const safePlan = plan || {};
  const min = safePlan.total_hours_min ?? 0;
  const max = safePlan.total_hours_max ?? min;
  const perDay = safePlan.hours_per_day ?? "your selected";
  $("planNote").textContent = `${safePlan.note || "A suggested sequence based on the findings above."} Estimated effort: about ${min}–${max} hours at ${perDay} hours/day. Treat this as a planning estimate, not a promise.`;
  const fixes = (safePlan.fixes || []).map((f) => `<article class="fix">
      <h3>${esc(f.title)}</h3>
      <div class="hrs">${esc(f.hours_min ?? "?")}–${esc(f.hours_max ?? "?")} HRS</div>
      <p>${esc(f.why || "")}</p>
      ${(f.reasons || []).length ? `<ul>${f.reasons.map((r) => `<li>${esc(r)}</li>`).join("")}</ul>` : ""}
    </article>`).join("");
  const days = (safePlan.timetable || []).map((d) => `<div class="day"><b>DAY ${esc(d.day)} · ${esc(d.hours)} H</b>${(d.tasks || []).map((t) => `${esc(t.title)} (${esc(t.hours)} h)`).join(" · ")}</div>`).join("");
  const unaddressed = (safePlan.unaddressed_gaps || []).length
    ? `<article class="note"><h3>Not a quick fix — this may need a new feature or project</h3>${safePlan.unaddressed_gaps.map((g) => `<p>${esc(g.reason)}</p>`).join("")}</article>`
    : "";
  $("plan").innerHTML = (fixes || '<p class="note">No fixes were suggested from this posting sample. That is not a guarantee that the project has no gaps.</p>') + days + unaddressed;
}

function renderSignals(signals) {
  $("signals").innerHTML = (signals || []).map((s) => {
    const ok = s.value === s.good_when_true;
    return `<li><span class="mark ${ok ? "yes" : "no"}" aria-hidden="true">${ok ? "✓" : "✕"}</span><span>${esc(s.label)}${s.note ? ` <span class="small">${esc(s.note)}</span>` : ""}</span></li>`;
  }).join("") || '<li>No repository checks were returned.</li>';
}

// Transparent UI-only heuristic: 70% of the score comes from detectable skill evidence,
// 30% from repository signals. It is NOT a hiring prediction or a measure of the person.
function calculateEvidenceScore(data) {
  const rows = (data.skill_matrix || []).filter((r) => r.detectable);
  const signals = data.signals || [];
  const skillScore = rows.length ? rows.filter((r) => r.in_repo).length / rows.length : null;
  const signalScore = signals.length ? signals.filter((s) => s.value === s.good_when_true).length / signals.length : null;
  if (skillScore === null && signalScore === null) return null;
  const weights = (skillScore !== null ? 0.7 : 0) + (signalScore !== null ? 0.3 : 0);
  const score = ((skillScore ?? 0) * (skillScore !== null ? 0.7 : 0) + (signalScore ?? 0) * (signalScore !== null ? 0.3 : 0)) / weights;
  return Math.round(score * 100) / 10;
}

function scoreComment(score) {
  if (score === null) return { sticker: "NO SCORE YET", explanation: "Not enough checkable data was returned to calculate a score." };
  if (score >= 9) return { sticker: "A+ ENERGY ✳", explanation: "Strong evidence coverage in this review. Keep checking the depth and quality of the implementation." };
  if (score >= 7.5) return { sticker: "SOLID DRAFT", explanation: "Good evidence in several areas, with a few marks still in the margin." };
  if (score >= 5.5) return { sticker: "PROMISING, REVISE", explanation: "Some useful evidence is here. Focus on the highest-priority gaps first." };
  if (score >= 3) return { sticker: "RED PEN TIME", explanation: "The current repository provides limited evidence against this rubric. That gives you a roadmap, not a verdict on your ability." };
  return { sticker: "BACK TO THE LAB", explanation: "Little checkable evidence was found by this rubric. Start with one small, demonstrable improvement at a time." };
}

function render(data) {
  const warning = data.postings?.warning || "";
  $("warning").hidden = !warning;
  $("warning").textContent = warning;
  const repo = data.repo || {};
  const role = data.role || {};
  const filesRead = (repo.files_read || []).length;
  $("repoMeta").innerHTML = `<a href="${esc(repo.url || "#")}" target="_blank" rel="noopener noreferrer">${esc(repo.full_name || repo.url || "Repository")}</a> reviewed for <b>${esc(role.label || "selected role")}</b> against ${esc(data.postings?.count ?? 0)} posting(s). Files read: ${filesRead}.${repo.tree_truncated ? " The repository file list was truncated by GitHub." : ""}`;
  $("summary").textContent = data.critique?.summary || "The review is complete. Check the evidence and notes below before deciding what to change.";
  const evidenceCheck = data.critique?.evidence_check || {};
  $("source").textContent = `Explanation source: ${data.critique?.source || "not specified"}. Checkable findings retained: ${evidenceCheck.findings_kept ?? "—"} of ${evidenceCheck.findings_total ?? "—"}.${data.critique?.llm_error ? " Model note: " + data.critique.llm_error : ""}`;
  renderMatrix(data.skill_matrix || []);
  $("findings").innerHTML = renderNotes(data.critique?.findings, "") || '<p class="note">No findings returned. This does not necessarily mean no gaps exist.</p>';
  $("strengths").innerHTML = renderNotes(data.critique?.strengths, "good") || '<p class="note good">No strengths were returned for this run.</p>';
  renderPlan(data.plan || {});
  renderSignals(data.signals || []);

  const score = calculateEvidenceScore(data);
  const comment = scoreComment(score);
  $("scoreNumber").innerHTML = score === null ? `—<span>/10</span>` : `${score.toFixed(1)}<span>/10</span>`;
  $("scoreSticker").textContent = comment.sticker;
  $("scoreExplanation").textContent = `${comment.explanation} Score rubric: 70% detectable skill evidence + 30% repository checks. This is a simple UI heuristic, not an employer rating.`;
  $("results").hidden = false;
}

$("form").addEventListener("submit", async (event) => {
  event.preventDefault();
  const pasted = $("postings").value.split(/^\s*---\s*$/m).map((s) => s.trim()).filter(Boolean);
  $("go").disabled = true;
  $("go").querySelector("span:first-child").textContent = "Marking in progress…";
  setStatus("Reading repository files and comparing them with the selected role. This can take up to a minute.");
  try {
    const response = await fetch("/api/review", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        repo_url: $("repo").value.trim(),
        role: $("role").value,
        pasted_postings: pasted,
        hours_per_day: parseFloat($("hours").value) || 2
      })
    });
    const data = await response.json();
    if (!response.ok) throw new Error(data.detail || "The review could not be completed. Please try again.");
    setStatus("Review complete. Read the evidence before acting on any recommendation.");
    render(data);
    $("results").scrollIntoView({ behavior: "smooth", block: "start" });
  } catch (error) {
    setStatus(error.message || "Something went wrong. Please try again.", true);
  } finally {
    $("go").disabled = false;
    $("go").querySelector("span:first-child").textContent = "Mark my repo";
  }
});

loadRoles();

// Redmargin help widget
const helpAnswers = {
  start: "Paste a public GitHub repository URL, choose your target role, and set your available hours per day. You can optionally paste job descriptions, then click “Mark my repo.” The current preview uses sample data rather than a live repository analysis.",

  score: "The score summarizes repository evidence against the review rubric. It is not a hiring prediction or a measure of your personal ability. In the current preview, the score is illustrative demo content.",

  evidence: "“Not found” means the review could not detect evidence in the inspected files. It does not mean you lack the skill. If you have relevant experience, add a verifiable project example, test, documentation, or demo. Some skills may need human review.",

  plan: "Start with the highest-priority task that fits your available time. Each revision should explain why it matters and give concrete steps. Treat hour estimates as planning guides, and prioritize making your project easier to reproduce, verify, and understand.",

  privacy: "Redmargin is designed to inspect repository files without running unknown project code. This visual preview uses illustrative sample data; it does not connect to a live reviewer backend, change your repository, or perform a real analysis."
};

function addHelpMessage(message, who = "bot") {
  const node = document.createElement("div");
  node.className = "help-message" + (who === "user" ? " user" : "");

  const paragraph = document.createElement("p");
  paragraph.textContent = message;

  node.appendChild(paragraph);
  $("helpMessages").appendChild(node);
  $("helpMessages").scrollTop = $("helpMessages").scrollHeight;
}

function answerHelp(question) {
  const q = question.toLowerCase();

  if (/score|grade|mark|rating|\b10\b/.test(q)) {
    return helpAnswers.score;
  }

  if (/not found|missing|gap|skill|evidence/.test(q)) {
    return helpAnswers.evidence;
  }

  if (/plan|priority|next|what should|improve|fix/.test(q)) {
    return helpAnswers.plan;
  }

  if (/privacy|safe|execute|run my code|change my repo|security/.test(q)) {
    return helpAnswers.privacy;
  }

  if (/start|begin|use|review|github|repo/.test(q)) {
    return helpAnswers.start;
  }

  return "I can help with starting a review, understanding your score, evidence gaps, your revision plan, and repository safety. Try one of the suggested topics above. This prototype does not have a live AI chat agent connected yet.";
}

function openHelp() {
  $("helpPanel").hidden = false;
  $("helpLauncher").setAttribute("aria-expanded", "true");
  $("helpInput").focus();
}

function closeHelp() {
  $("helpPanel").hidden = true;
  $("helpLauncher").setAttribute("aria-expanded", "false");
  $("helpLauncher").focus();
}

$("helpLauncher").addEventListener("click", () => {
  if ($("helpPanel").hidden) {
    openHelp();
  } else {
    closeHelp();
  }
});

$("helpClose").addEventListener("click", closeHelp);

$("helpOptions").addEventListener("click", (event) => {
  const button = event.target.closest("button[data-help]");
  if (!button) return;

  addHelpMessage(button.textContent, "user");
  addHelpMessage(helpAnswers[button.dataset.help]);
});

$("helpForm").addEventListener("submit", (event) => {
  event.preventDefault();

  const input = $("helpInput");
  const question = input.value.trim();

  if (!question) return;

  addHelpMessage(question, "user");
  addHelpMessage(answerHelp(question));

  input.value = "";
  input.focus();
});
