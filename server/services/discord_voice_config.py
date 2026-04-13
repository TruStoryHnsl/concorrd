from __future__ import annotations

import json
import os
import tempfile
from pathlib import Path
from typing import TypedDict

from sqlalchemy import select
from sqlalchemy.ext.asyncio import AsyncSession

from models import DiscordVoiceBridge


CONFIG_DIR = Path(os.getenv("CONCORD_DISCORD_VOICE_CONFIG_DIR", "/etc/concord-config/discord-voice-bridge"))
ROOMS_FILE = CONFIG_DIR / "rooms.json"


class DiscordVoiceRoom(TypedDict):
    id: int
    server_id: str
    channel_id: int
    matrix_room_id: str
    discord_guild_id: str
    discord_channel_id: str
    enabled: bool


def _atomic_write_json(path: Path, payload: object) -> None:
    path.parent.mkdir(parents=True, exist_ok=True)
    encoded = json.dumps(payload, indent=2, sort_keys=True).encode("utf-8")

    fd, tmp_name = tempfile.mkstemp(
        prefix=f".{path.name}.",
        suffix=".tmp",
        dir=path.parent,
    )
    tmp_path = Path(tmp_name)
    try:
        with os.fdopen(fd, "wb") as fh:
            fh.write(encoded)
            fh.write(b"\n")
            fh.flush()
            os.fsync(fh.fileno())
        os.chmod(tmp_path, 0o640)
        os.replace(tmp_path, path)
    finally:
        if tmp_path.exists():
            tmp_path.unlink()


async def list_voice_bridge_rooms(db: AsyncSession) -> list[DiscordVoiceRoom]:
    result = await db.execute(
        select(DiscordVoiceBridge).order_by(DiscordVoiceBridge.id)
    )
    rooms: list[DiscordVoiceRoom] = []
    for row in result.scalars().all():
        rooms.append({
            "id": row.id,
            "server_id": row.server_id,
            "channel_id": row.channel_id,
            "matrix_room_id": row.matrix_room_id,
            "discord_guild_id": row.discord_guild_id,
            "discord_channel_id": row.discord_channel_id,
            "enabled": bool(row.enabled),
        })
    return rooms


async def write_voice_bridge_rooms(db: AsyncSession) -> None:
    rooms = await list_voice_bridge_rooms(db)
    _atomic_write_json(ROOMS_FILE, {"rooms": rooms})

