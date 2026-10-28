#!/usr/bin/env python
# -*- coding: utf-8 -*-
"""Edge TTS（微软神经语音）→ qq-bridge 语音发送
用法: python tts-edge.py "文本" [voice] [key]
  voice 默认 zh-CN-XiaoyiNeural（少女音）；可选 zh-CN-XiaoxiaoNeural / zh-CN-liaoning-XiaobeiNeural 等
  key   默认 private:<ownerQQ>
免费、无需密钥，输出 mp3 直接交给桥接（SnowLuma 自转 SILK）。
"""
import asyncio
import json
import sys
import time
import urllib.request
from pathlib import Path

import edge_tts

HERE = Path(__file__).resolve().parent
AUDIO = HERE / "audio"
STATE = HERE / "state"
BRIDGE = "http://127.0.0.1:3100"


def read_json(p: Path):
    return json.loads(p.read_text(encoding="utf-8"))


def main() -> int:
    text = (sys.argv[1] if len(sys.argv) > 1 else "").strip()
    voice = (sys.argv[2] if len(sys.argv) > 2 else "zh-CN-XiaoyiNeural").strip()
    key = (sys.argv[3] if len(sys.argv) > 3 else "private:YOUR_QQ").strip()
    if not text:
        print("缺少文本", file=sys.stderr)
        return 2

    cfg = read_json(HERE / "config.json")
    edge_cfg = cfg.get("tts", {}).get("edge", {})
    rate = edge_cfg.get("rate", "+0%")
    pitch = edge_cfg.get("pitch", "+0Hz")

    AUDIO.mkdir(parents=True, exist_ok=True)
    name = f"edge-{voice}-{int(time.time())}.mp3"
    out = AUDIO / name

    async def synth():
        comm = edge_tts.Communicate(text, voice, rate=rate, pitch=pitch)
        await comm.save(str(out))

    asyncio.run(synth())
    size = out.stat().st_size
    if size < 1000:
        print(f"合成结果异常（{size} 字节）", file=sys.stderr)
        return 3

    console_token = (STATE / "console-token").read_text(encoding="utf-8").strip()
    social = read_json(STATE / "social-v2.json")
    agent_token = social.get("conversations", {}).get(key, {}).get("agentToken")
    if not agent_token:
        print(f"找不到会话 {key} 的 agentToken", file=sys.stderr)
        return 4

    payload = json.dumps({"key": key, "token": agent_token, "voice": name}).encode("utf-8")
    req = urllib.request.Request(
        f"{BRIDGE}/api/socialV2/send-voice",
        data=payload,
        method="POST",
        headers={
            "content-type": "application/json; charset=utf-8",
            "x-console-token": console_token,
            "x-agent-call": "1",
            "x-agent-token": agent_token,
        },
    )
    try:
        with urllib.request.urlopen(req, timeout=90) as resp:
            body = json.loads(resp.read().decode("utf-8") or "{}")
    except urllib.error.HTTPError as e:  # 服务器返回错误体
        body = e.read().decode("utf-8", "replace")
        print(f"发送失败 HTTP {e.code}: {body[:400]}", file=sys.stderr)
        return 5

    print(json.dumps({
        "ok": True,
        "voice": voice,
        "file": name,
        "bytes": size,
        "messageId": body.get("messageId"),
        "verified": body.get("verified"),
        "warnings": body.get("warnings"),
    }, ensure_ascii=False, indent=2))
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
