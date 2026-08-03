#!/usr/bin/env python3
"""
SYNCLIKA Share — Runner
========================
One script to replace the pile of .bat files: checks Node, installs deps on
first run, starts desklink-server.js, waits for it to come up, opens the
/select launcher in your browser, and streams the server's own log lines
into this console. Ctrl+C (or closing this window) stops the server.

Usage:
    python runner.py                  # normal start
    python runner.py --no-browser     # don't auto-open a browser tab
    python runner.py --port 7331      # override the port (default 7331)

Build a standalone runner.exe (Windows, run ON Windows):
    pip install pyinstaller
    pyinstaller --onefile --name SYNCLIKA-Runner runner.py
    -> dist/SYNCLIKA-Runner.exe
"""
import argparse
import shutil
import socket
import subprocess
import sys
import time
import webbrowser
from pathlib import Path

HERE = Path(__file__).resolve().parent
SERVER_FILE = HERE / "desklink-server.js"
NODE_MODULES = HERE / "node_modules"

BANNER = r"""
   ______   ___  _  __  ______  __    __  __ __  ___
  / __/ /  / _ \| |/_/ / __/ / / /_______\ \/ // //_/ _ |
 _\ \/ /__/ // />  <  _\ \/ /_  / __/ __// _  / / , _/ __ |
/___/____/____/_/|_| /___/\____/\__/_/  /_//_/ /_/|_/_/ |_|

  SYNCLIKA Share — Runner
"""


def die(msg: str, code: int = 1) -> None:
    print(f"\n✗ {msg}\n")
    input("Press Enter to close...")
    sys.exit(code)


def find_node() -> str:
    node = shutil.which("node")
    if not node:
        die(
            "Node.js was not found on your PATH.\n"
            "  Install the LTS build from https://nodejs.org and run this again."
        )
    return node


def find_npm() -> str:
    npm = shutil.which("npm") or shutil.which("npm.cmd")
    if not npm:
        die("npm was not found on your PATH (it ships with Node.js — reinstall Node).")
    return npm


def ensure_dependencies() -> None:
    if NODE_MODULES.exists():
        return
    print("First run — installing dependencies (npm install)…")
    npm = find_npm()
    proc = subprocess.run([npm, "install", "--no-fund", "--no-audit"], cwd=str(HERE))
    if proc.returncode != 0:
        die("npm install failed — check your internet connection and try again.")


def port_open(host: str, port: int, timeout: float = 0.4) -> bool:
    try:
        with socket.create_connection((host, port), timeout=timeout):
            return True
    except OSError:
        return False


def wait_for_server(port: int, timeout_s: float = 25.0) -> bool:
    deadline = time.time() + timeout_s
    while time.time() < deadline:
        if port_open("127.0.0.1", port, 0.5):
            return True
        time.sleep(0.3)
    return False


def main() -> None:
    parser = argparse.ArgumentParser(description="Run the SYNCLIKA Share server + launcher.")
    parser.add_argument("--no-browser", action="store_true", help="Don't auto-open the launcher in a browser")
    parser.add_argument("--port", type=int, default=7331, help="Server port (default: 7331)")
    args = parser.parse_args()

    print(BANNER)

    if not SERVER_FILE.exists():
        die(f"desklink-server.js not found next to runner.py ({HERE})")

    node = find_node()
    ensure_dependencies()

    if port_open("127.0.0.1", args.port):
        print(f"⚠  Something is already listening on port {args.port} — assuming SYNCLIKA is already running.")
    else:
        print(f"Starting desklink-server.js on port {args.port} …")

    env_note = "" if args.port == 7331 else f" (custom port {args.port})"
    if env_note:
        print(f"  note:{env_note}")

    import os
    child_env = os.environ.copy()
    child_env["PORT"] = str(args.port)

    proc = subprocess.Popen(
        [node, str(SERVER_FILE)],
        cwd=str(HERE),
        stdout=subprocess.PIPE,
        stderr=subprocess.STDOUT,
        text=True,
        bufsize=1,
        env=child_env,
    )

    ready = wait_for_server(args.port)
    if ready and not args.no_browser:
        url = f"http://127.0.0.1:{args.port}/select"
        print(f"\n✓ Server is up → opening {url}\n")
        try:
            webbrowser.open(url)
        except Exception:
            print(f"  Couldn't auto-open a browser — visit {url} manually.")
    elif not ready:
        print("\n⚠  Server didn't answer on that port yet — it may still be starting. Check the log below.\n")

    print("─" * 60)
    print("  Live server log (Ctrl+C to stop everything)")
    print("─" * 60)

    try:
        for line in proc.stdout:
            print(line, end="")
    except KeyboardInterrupt:
        pass
    finally:
        print("\nStopping SYNCLIKA server…")
        proc.terminate()
        try:
            proc.wait(timeout=5)
        except subprocess.TimeoutExpired:
            proc.kill()
        print("Stopped.")


if __name__ == "__main__":
    try:
        main()
    except SystemExit:
        raise
    except Exception as exc:  # last-resort safety net so the window never just vanishes
        import traceback
        traceback.print_exc()
        die(f"Unexpected error: {exc}")
