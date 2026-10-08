#!/usr/bin/env python3
"""Insta Tools helper: a native messaging host that runs yt-dlp.

Chrome starts this program when the extension asks for it, sends one JSON
message on stdin and reads one JSON reply from stdout. Each message is
prefixed with its length as a 4 byte little-endian integer.

Requests:
  {"action": "ping"}
  {"action": "download", "code": "<post shortcode>", "name": "<file name, no extension>"}

The extension only ever sends a shortcode and a plain file name. This program
builds the Instagram address and the output path itself and never runs a
shell, so a page cannot make it fetch other sites or write outside the
download folder.

Settings are optional and live in ~/.config/insta-tools/config.json. See
DEFAULTS below for the keys.
"""

import json
import os
import re
import shutil
import struct
import subprocess
import sys
import time
from pathlib import Path

DEFAULTS = {
    # Where finished videos are saved.
    "download_dir": "~/Downloads/Insta Tools",
    # Browser whose Instagram login yt-dlp may borrow when a download fails
    # without one (passed to --cookies-from-browser). Set to "" to never use it.
    "cookies_from_browser": "chrome",
    # Full paths, only needed when the programs are not found automatically.
    "yt_dlp": "",
    "ffmpeg": "",
    "timeout_seconds": 600,
}

CONFIG_PATH = Path(os.environ.get("XDG_CONFIG_HOME") or Path.home() / ".config") / "insta-tools" / "config.json"
# What each download attempt did, since Chrome shows the helper's stderr nowhere.
LOG_PATH = Path(os.environ.get("XDG_STATE_HOME") or Path.home() / ".local" / "state") / "insta-tools" / "helper.log"
LOG_LIMIT = 256 * 1024
# Chrome can start the helper with a shorter PATH than a terminal has.
EXTRA_PATH = ["~/.local/bin", "~/bin", "/usr/local/bin", "/opt/homebrew/bin", "/usr/bin", "/bin"]
CODE_RE = re.compile(r"^[A-Za-z0-9_-]{5,20}$")
NAME_RE = re.compile(r"^[A-Za-z0-9_.-]{1,120}$")
BROWSER_RE = re.compile(r"^[A-Za-z0-9_+:./ -]{1,200}$")


def read_message():
    header = sys.stdin.buffer.read(4)
    if len(header) < 4:
        return None
    (length,) = struct.unpack("<I", header)
    return json.loads(sys.stdin.buffer.read(length).decode("utf-8"))


def send_message(message):
    data = json.dumps(message).encode("utf-8")
    sys.stdout.buffer.write(struct.pack("<I", len(data)) + data)
    sys.stdout.buffer.flush()


def load_config():
    config = dict(DEFAULTS)
    try:
        stored = json.loads(CONFIG_PATH.read_text(encoding="utf-8"))
        if isinstance(stored, dict):
            config.update({key: value for key, value in stored.items() if key in DEFAULTS})
    except FileNotFoundError:
        pass
    except (OSError, ValueError) as error:
        config["_config_error"] = f"Could not read {CONFIG_PATH}: {error}"
    return config


def find_program(name, configured):
    if configured:
        path = Path(configured).expanduser()
        return str(path) if path.is_file() else None
    search = os.pathsep.join([os.environ.get("PATH", "")] + [str(Path(p).expanduser()) for p in EXTRA_PATH])
    return shutil.which(name, path=search)


def run(command, timeout):
    # stdin is closed and output is captured so the child can never touch the
    # pipes this program uses to talk to Chrome.
    # Browsers pass their own library settings on to native hosts, and ffmpeg
    # would load those libraries too. Vivaldi preloads its cut-down
    # libffmpeg.so, which crashes ffmpeg during the merge and leaves separate
    # video and audio files. Helium puts its bundled libvulkan first.
    env = {key: value for key, value in os.environ.items() if key not in ("LD_PRELOAD", "LD_LIBRARY_PATH")}
    return subprocess.run(
        command, stdin=subprocess.DEVNULL, stdout=subprocess.PIPE, stderr=subprocess.PIPE,
        text=True, errors="replace", timeout=timeout, check=False, env=env,
    )


def log(text):
    try:
        LOG_PATH.parent.mkdir(parents=True, exist_ok=True)
        if LOG_PATH.exists() and LOG_PATH.stat().st_size > LOG_LIMIT:
            LOG_PATH.replace(LOG_PATH.with_suffix(".log.old"))
        stamp = time.strftime("%Y-%m-%d %H:%M:%S")
        with LOG_PATH.open("a", encoding="utf-8") as handle:
            handle.write(f"[{stamp} pid {os.getpid()}] {text.rstrip()}\n")
    except OSError:
        pass  # logging must never break a download


def last_lines(text, limit=400):
    # --verbose prints debug lines and a traceback after the error, so the
    # ERROR lines are what the tooltip should show.
    errors = [line.strip() for line in text.splitlines() if line.startswith("ERROR:")]
    return " ".join(errors[-2:])[-limit:]


def ping(config):
    yt_dlp = find_program("yt-dlp", config["yt_dlp"])
    version = None
    if yt_dlp:
        try:
            version = run([yt_dlp, "--version"], 20).stdout.strip() or None
        except (OSError, subprocess.SubprocessError):
            version = None
    return {
        "ok": True,
        "yt_dlp": yt_dlp,
        "yt_dlp_version": version,
        "ffmpeg": find_program("ffmpeg", config["ffmpeg"]),
        "download_dir": str(Path(config["download_dir"]).expanduser()),
        "cookies_from_browser": config["cookies_from_browser"],
        "config_path": str(CONFIG_PATH),
        "config_error": config.get("_config_error"),
    }


def download(config, code, name):
    if not isinstance(code, str) or not CODE_RE.match(code):
        return {"ok": False, "error": "Bad post code"}
    if not isinstance(name, str) or not NAME_RE.match(name) or name.startswith((".", "-")):
        return {"ok": False, "error": "Bad file name"}

    yt_dlp = find_program("yt-dlp", config["yt_dlp"])
    if not yt_dlp:
        return {"ok": False, "code": "no-yt-dlp", "error": "yt-dlp was not found. Install it, or set yt_dlp in the config file."}

    folder = Path(config["download_dir"]).expanduser()
    try:
        folder.mkdir(parents=True, exist_ok=True)
    except OSError as error:
        return {"ok": False, "error": f"Cannot create {folder}: {error}"}

    base = [
        yt_dlp,
        # The user's own yt-dlp config can add --cookies or other options,
        # which would make the first attempt a logged-in one.
        "--ignore-config",
        # Only goes to the log. It shows the exact ffmpeg command when a merge fails.
        "--verbose",
        "--no-playlist", "--no-progress", "--force-overwrites",
        # Best video plus best audio, merged. Falls back to the best single file.
        "--format", "bv*+ba/b",
        "--merge-output-format", "mp4",
        "--paths", str(folder),
        "--output", f"{name}.%(ext)s",
        "--no-simulate",
        "--print", "after_move:%(filepath)s\t%(width)sx%(height)s",
    ]
    ffmpeg = find_program("ffmpeg", config["ffmpeg"])
    if ffmpeg and config["ffmpeg"]:
        base += ["--ffmpeg-location", ffmpeg]
    url = f"https://www.instagram.com/reel/{code}/"

    # First without a login. Only if that fails, retry with the browser's
    # Instagram session, so requests are made as your account no more than needed.
    attempts = [[]]
    browser = config["cookies_from_browser"]
    if isinstance(browser, str) and browser and BROWSER_RE.match(browser):
        attempts.append(["--cookies-from-browser", browser])

    problem = "yt-dlp did not run"
    log(f"download {code} as {name}, ffmpeg {ffmpeg}, parent pid {os.getppid()}, "
        f"PATH={os.environ.get('PATH', '')}, LD_LIBRARY_PATH={os.environ.get('LD_LIBRARY_PATH', '')}, "
        f"LD_PRELOAD={os.environ.get('LD_PRELOAD', '')}")
    for extra in attempts:
        started = time.monotonic()
        try:
            result = run(base + extra + ["--", url], int(config["timeout_seconds"]))
        except subprocess.TimeoutExpired:
            problem = f"yt-dlp took longer than {config['timeout_seconds']} seconds"
            log(f"attempt {extra or 'plain'}: {problem}")
            continue
        except OSError as error:
            return {"ok": False, "error": f"Could not start yt-dlp: {error}"}

        log(f"attempt {extra or 'plain'}: exit {result.returncode} after {time.monotonic() - started:.1f}s\n"
            f"  stdout: {result.stdout.strip()}\n  stderr: {result.stderr.strip()[-12000:]}")
        printed = [line for line in result.stdout.splitlines() if line.strip()]
        if result.returncode == 0 and printed:
            path, _, size = printed[-1].partition("\t")
            if Path(path).is_file():
                return {
                    "ok": True,
                    "file": path,
                    "size": size if re.match(r"^\d+x\d+$", size) else None,
                    "used_login": bool(extra),
                    "merged": bool(ffmpeg),
                }
        problem = last_lines(result.stderr) or f"yt-dlp exited with code {result.returncode} (details in {LOG_PATH})"

    if not ffmpeg:
        problem += " (ffmpeg was not found, so separate video and audio cannot be merged)"
    return {"ok": False, "code": "yt-dlp-failed", "error": problem}


def main():
    try:
        message = read_message()
        if not isinstance(message, dict):
            send_message({"ok": False, "error": "No request received"})
            return
        config = load_config()
        action = message.get("action")
        if action == "ping":
            send_message(ping(config))
        elif action == "download":
            send_message(download(config, message.get("code"), message.get("name")))
        else:
            send_message({"ok": False, "error": "Unknown action"})
    except Exception as error:  # the reply is the only place an error can be seen
        send_message({"ok": False, "error": f"Helper crashed: {error}"})


if __name__ == "__main__":
    main()
