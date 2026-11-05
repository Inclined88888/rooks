"""rooks-try: disposable computer on this machine."""

from __future__ import annotations

import argparse
import json
import os
import sys

from . import __version__
from .room import TryRoom


def main(argv: list[str] | None = None) -> int:
    ap = argparse.ArgumentParser(prog="rooks-try", description="A disposable computer on this machine for the agent to try things.")
    ap.add_argument("--version", action="version", version=f"rooks-try {__version__}")
    ap.add_argument("--driver", choices=["auto", "qemu", "nested", "shell"],
                    default=os.environ.get("ROOKS_TRY_DRIVER", "auto"))
    ap.add_argument("--offline", action="store_true", help="No network inside the room when the driver supports it")
    sub = ap.add_subparsers(dest="cmd", required=True)

    sub.add_parser("up", help="Start the Try Room")
    sub.add_parser("down", help="Stop the Try Room")
    sub.add_parser("status", help="Show driver and checkpoints")
    p_shot = sub.add_parser("screenshot", help="Save a PNG of the guest screen")
    p_shot.add_argument("-o", "--output", default="")
    p_cp = sub.add_parser("checkpoint", help="Save a restore point")
    p_cp.add_argument("label", nargs="?", default="")
    p_reset = sub.add_parser("reset", help="Restore a checkpoint")
    p_reset.add_argument("name", nargs="?", default="")
    p_run = sub.add_parser("run", help="Run a command inside the room")
    p_run.add_argument("command")
    sub.add_parser("mcp", help="MCP server on stdio")
    p_serve = sub.add_parser("serve", help="Local HTTP API for the Rooks app")
    p_serve.add_argument("--host", default="127.0.0.1")
    p_serve.add_argument("--port", type=int, default=3127)
    sub.add_parser("prepare", help="Explain how to attach a Linux guest image for QEMU")
    sub.add_parser("drivers", help="List drivers on this computer")

    args = ap.parse_args(argv)
    if args.cmd == "mcp":
        from .mcp_server import main as mcp_main
        return mcp_main()
    if args.cmd == "serve":
        from .server import serve
        serve(args.host, args.port, driver=args.driver, offline=args.offline)
        return 0
    if args.cmd == "prepare":
        print("Try Room uses a Linux guest on every host (Mac, Windows, Linux).")
        print("1. Install QEMU for your system.")
        print("2. Download a small Linux cloud image (Alpine or Debian) as qcow2.")
        print("3. Export it:  export ROOKS_TRY_IMAGE=/path/to/image.qcow2")
        print("4. Start:      rooks-try --driver qemu up")
        print("Without an image, Linux hosts use a private nested desktop; everyone can use shell mode.")
        return 0

    room = TryRoom(prefer=args.driver, offline=args.offline)
    try:
        if args.cmd == "up":
            _print(room.up())
        elif args.cmd == "down":
            _print(room.down())
        elif args.cmd == "status":
            _print(room.status())
        elif args.cmd == "drivers":
            _print(room.drivers())
        elif args.cmd == "screenshot":
            path = room.screenshot(args.output or None)
            print(path)
        elif args.cmd == "checkpoint":
            _print(room.checkpoint(args.label))
        elif args.cmd == "reset":
            _print(room.reset(args.name or None))
        elif args.cmd == "run":
            result = room.run(args.command)
            _print(result)
            return 0 if result.get("ok") else 1
        else:
            ap.error(f"unknown command {args.cmd}")
    except Exception as exc:  # noqa: BLE001
        print(f"rooks-try: {exc}", file=sys.stderr)
        return 1
    return 0


def _print(data) -> None:
    print(json.dumps(data, indent=2))


if __name__ == "__main__":
    raise SystemExit(main())
