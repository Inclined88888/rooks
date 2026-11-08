"""The workplace cleanup (docs/architecture.md, section g) stays done: removed things do not come back."""

import shutil
import subprocess
from pathlib import Path

import pytest

ROOT = Path(__file__).resolve().parents[3]


def _tracked(*paths: str) -> list[str]:
    if not shutil.which("git") or not (ROOT / ".git").exists():
        pytest.skip("not a git checkout")
    out = subprocess.run(["git", "ls-files", "--", *paths], cwd=ROOT, capture_output=True, text=True, check=True)
    return [line for line in out.stdout.splitlines() if line]


def test_screenshots_folder_is_not_tracked():
    """`.gitignore` keeps /screenshots/ for throwaway captures; 347 old pictures (40 MB) were tracked anyway."""
    tracked = _tracked("screenshots")
    assert not tracked, f"{len(tracked)} files under screenshots/ are tracked again, e.g. {tracked[:3]}"
    assert "/screenshots/" in (ROOT / ".gitignore").read_text().splitlines()


def test_removed_root_files_stay_removed():
    gone = ["marketing/launch-posts.md", "PROGRESS-desktop.md", "ai-workspace-audit-report.md",
            "scripts/test_vertical_slice.py"]
    assert not _tracked(*gone)


# ---- the old browser agent (browser-agent/) is replaced by rooks-browser everywhere --------------------------------
# Where the old folder's name may still appear: the record of what happened, not instructions to run it.
HISTORY = ("CHANGELOG.md", "BACKLOG.md", "docs/architecture.md", "docs/history/")


def _services(compose: str) -> dict[str, str]:
    """Top-level services of a compose file, each with its own block of text (no YAML parser needed)."""
    out: dict[str, str] = {}
    name, block, inside = "", [], False
    for line in compose.splitlines():
        if line and not line.startswith((" ", "#")):
            inside = line.startswith("services:")
            if name:
                out[name], name = "\n".join(block), ""
            continue
        if inside and len(line) > 2 and line[2] not in " #" and line.startswith("  ") and line.rstrip().endswith(":"):
            if name:
                out[name] = "\n".join(block)
            name, block = line.strip()[:-1], []
        elif name:
            block.append(line)
    if name:
        out[name] = "\n".join(block)
    return out


def test_old_browser_agent_folder_is_gone():
    assert not _tracked("browser-agent"), "browser-agent/ is tracked again; rooks-browser replaced it"


def test_nothing_runs_or_points_at_the_old_browser_agent():
    if not shutil.which("git"):
        pytest.skip("git is needed")
    out = subprocess.run(["git", "grep", "-l", "-F", "-e", "browser-agent/", "-e", "./browser-agent", "-e", "browser_agent.",
                          "-e", "browser-agent-server", "--", ".", ":!workbench/frontend/dist"],
                         cwd=ROOT, capture_output=True, text=True)
    hits = [p for p in out.stdout.splitlines() if p and not p.startswith(HISTORY)
            and p != "workbench/backend/tests/test_repo_cleanup.py"]
    assert not hits, f"still refers to the old browser agent: {hits}"


def test_docker_browser_add_on_is_rooks_browser():
    services = _services((ROOT / "docker-compose.yml").read_text())
    browser = services.get("browser", "")
    assert browser, "the browser add-on is still offered"
    assert "context: ./rooks-browser" in browser or "build: ./rooks-browser" in browser
    assert (ROOT / "rooks-browser" / "Dockerfile").is_file()
    # service mode: a token is required and the stack's own hosts (workbench, ollama, ...) are out of reach
    assert "ROOKS_BROWSER_BLOCK_PRIVATE" in browser and "ROOKS_BROWSER_TOKEN" in browser


def test_background_add_ons_do_not_get_the_shared_app_key():
    """Paperclip and Hermes run agents unattended. BROWSER_API_KEY answers the browser helper's approvals and the
    terminal's prompts, so holding it would let them approve their own requests (docs/security/agent-credentials.md)."""
    services = _services((ROOT / "docker-compose.yml").read_text())
    for name in ("paperclip", "hermes"):
        assert name in services, name
        assert "BROWSER_API_KEY" not in services[name], f"{name} is given BROWSER_API_KEY"
    for f in ("paperclip/opencode.json", "scripts/sync-opencode-config.sh", "scripts/hermes-config.sh"):
        assert "BROWSER_API_KEY" not in (ROOT / f).read_text(), f
    assert not [ln for ln in (ROOT / "setup.sh").read_text().splitlines() if "WEBUI_BROWSER_TOOL" in ln and "BROWSER_API_KEY" in ln]


def test_ci_has_no_job_for_the_old_browser_agent():
    ci = (ROOT / ".github" / "workflows" / "ci.yml").read_text()
    assert "working-directory: browser-agent" not in ci
    assert "\n  browser-agent:" not in ci


# ---- modules named after old branches carry their purpose (architecture g.4); every route keeps its path ----------
RENAMED = {"v02_api": "automations_api", "v02_hooks": "projects_hooks", "v02_mobile": "projects_mobile",
           "features_v02": "plan_tiers"}


def test_branch_named_modules_are_renamed():
    app = ROOT / "workbench" / "backend" / "app"
    for old, new in RENAMED.items():
        assert not (app / f"{old}.py").exists(), old
        assert (app / f"{new}.py").is_file(), new
    # the catalog builder is a build tool, not part of the running app
    assert not (app / "catalog_build.py").exists()
    assert (ROOT / "scripts" / "build_model_catalog.py").is_file()


def test_renamed_modules_still_serve_their_routes(client):
    """One route from each renamed module (automations_api's three routers, projects_hooks, projects_mobile), at the
    same path as before the rename."""
    paths = {r.path for r in client.app.routes}
    for path in ("/api/automations", "/api/jobs/notices", "/api/mobile/jobs", "/api/projects", "/api/history",
                 "/api/checked/mode", "/api/mobile/projects", "/api/mobile/history", "/api/mobile/checked/mode"):
        assert path in paths, path
