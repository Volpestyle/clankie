"""Exercise only CLI parsing: no invocation here may create NSApplication."""
import subprocess
from pathlib import Path

binary = Path(__file__).resolve().parent / ".build/debug/ClankieDesktopFixture"
for arguments in [[], ["--help"]]:
    result = subprocess.run([str(binary), *arguments], capture_output=True, text=True, timeout=5)
    assert result.returncode == 0, result
    assert "--run" in result.stdout
    assert '"window_created"' not in result.stdout

for arguments in [
    ["--run"],
    ["--run", "target", "--seconds", "0"],
    ["--run", "target", "--seconds", "121"],
    ["--run", "target", "--seconds", "nan"],
    ["--run", "unknown", "--seconds", "10"],
    ["--run", "operator", "--seconds", "10", "--extra"],
]:
    result = subprocess.run([str(binary), *arguments], capture_output=True, text=True, timeout=5)
    assert result.returncode == 64, result
    assert not result.stdout, result.stdout
    assert "Invalid fixture arguments" in result.stderr
print("8 inert CLI cases passed; no --run invocation was accepted.")
