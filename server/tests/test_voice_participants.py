from __future__ import annotations

from types import SimpleNamespace
from typing import Any
from unittest.mock import AsyncMock

from httpx import AsyncClient

from models import Channel, Server, ServerMember
from tests.conftest import login_as, logout


async def _seed_voice_server(db_session: Any) -> Channel:
    server = Server(id="srv_voice_presence", name="Voice Presence", owner_id="@owner:test.local")
    voice_channel = Channel(
        server_id=server.id,
        matrix_room_id="!voice:test.local",
        name="Voice",
        channel_type="voice",
    )
    member = ServerMember(
        server_id=server.id,
        user_id="@regular:test.local",
        role="member",
    )
    db_session.add_all([server, voice_channel, member])
    await db_session.commit()
    await db_session.refresh(voice_channel)
    return voice_channel


class _FakeRoomService:
    def __init__(self, participants: list[SimpleNamespace] | None = None, error: Exception | None = None):
        self._participants = participants or []
        self._error = error

    async def list_participants(self, _request: Any) -> Any:
        if self._error:
            raise self._error
        return SimpleNamespace(participants=self._participants)


class _FakeLiveKitAPI:
    def __init__(self, participants: list[SimpleNamespace] | None = None, error: Exception | None = None):
        self.room = _FakeRoomService(participants=participants, error=error)

    async def aclose(self) -> None:
        return None


async def test_voice_participants_merges_discord_sidecar_presence(
    client: AsyncClient,
    db_session: Any,
    monkeypatch,
) -> None:
    await _seed_voice_server(db_session)

    from routers import voice as voice_router

    monkeypatch.setattr(
        voice_router.livekit_api,
        "LiveKitAPI",
        lambda *_args, **_kwargs: _FakeLiveKitAPI(
            participants=[
                SimpleNamespace(identity="@regular:test.local", name="regular"),
            ]
        ),
    )
    monkeypatch.setattr(
        voice_router,
        "_fetch_discord_voice_participants",
        AsyncMock(
            return_value={
                "!voice:test.local": [
                    {
                        "identity": "discord-member:!voice:test.local:123",
                        "name": "Discord Friend",
                        "source": "discord",
                    }
                ]
            }
        ),
    )

    login_as("@regular:test.local")
    resp = await client.get("/api/voice/participants", params={"rooms": "!voice:test.local"})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "!voice:test.local": [
            {"identity": "@regular:test.local", "name": "regular"},
            {
                "identity": "discord-member:!voice:test.local:123",
                "name": "Discord Friend",
                "source": "discord",
            },
        ]
    }
    logout()


async def test_voice_participants_falls_back_to_discord_presence_when_livekit_fails(
    client: AsyncClient,
    db_session: Any,
    monkeypatch,
) -> None:
    await _seed_voice_server(db_session)

    from routers import voice as voice_router

    monkeypatch.setattr(
        voice_router.livekit_api,
        "LiveKitAPI",
        lambda *_args, **_kwargs: _FakeLiveKitAPI(error=RuntimeError("livekit down")),
    )
    monkeypatch.setattr(
        voice_router,
        "_fetch_discord_voice_participants",
        AsyncMock(
            return_value={
                "!voice:test.local": [
                    {
                        "identity": "discord-member:!voice:test.local:321",
                        "name": "Voice Friend",
                        "source": "discord",
                    }
                ]
            }
        ),
    )

    login_as("@regular:test.local")
    resp = await client.get("/api/voice/participants", params={"rooms": "!voice:test.local"})
    assert resp.status_code == 200, resp.text
    assert resp.json() == {
        "!voice:test.local": [
            {
                "identity": "discord-member:!voice:test.local:321",
                "name": "Voice Friend",
                "source": "discord",
            }
        ]
    }
    logout()
