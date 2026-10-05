#!/usr/bin/env python3
"""重置/重建演示数据：调用协调器的 /api/dev/reset（清空 WAL 并重新播种）。"""
import argparse
import json
import os
import urllib.request


def main() -> None:
    ap = argparse.ArgumentParser(description="重置值班席位租约协调器演示数据")
    ap.add_argument("--url", default=os.environ.get("SEATLEASE_URL",
                                                    "http://localhost:8092"))
    args = ap.parse_args()
    req = urllib.request.Request(f"{args.url}/api/dev/reset",
                                 data=b"{}", method="POST",
                                 headers={"Content-Type": "application/json"})
    with urllib.request.urlopen(req, timeout=5) as r:
        out = json.loads(r.read())
    st = out["state"]
    print("已重置。当前席位：")
    for s in st["seats"]:
        print(f"  {s['id']} g{s['generation']} 持有人={s['holder_name']} "
              f"阶段={s['phase']}")
    print("人员：", "、".join(f"{p['name']}({'有' if p['witness_qualified'] else '无'}见证资格)"
                             for p in st["people"]))


if __name__ == "__main__":
    main()
