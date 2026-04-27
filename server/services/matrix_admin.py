from typing import Optional
from urllib.parse import quote

import httpx

from config import MATRIX_HOMESERVER_URL, MATRIX_REGISTRATION_TOKEN


async def register_matrix_user(
    username: str, password: str
) -> dict:
    """Register a new user on the Matrix homeserver using the registration token."""
    async with httpx.AsyncClient() as client:
        # Step 1: Initiate registration to get UIAA session
        resp = await client.post(
            f"{MATRIX_HOMESERVER_URL}/_matrix/client/v3/register",
            json={"username": username, "password": password},
        )
        data = resp.json()

        if resp.status_code == 200:
            return data  # Open registration (unlikely)

        if "session" not in data:
            raise Exception(data.get("error", "Registration failed"))

        session_id = data["session"]

        # Step 2: Complete with registration token
        resp = await client.post(
            f"{MATRIX_HOMESERVER_URL}/_matrix/client/v3/register",
            json={
                "username": username,
                "password": password,
                "auth": {
                    "type": "m.login.registration_token",
                    "token": MATRIX_REGISTRATION_TOKEN,
                    "session": session_id,
                },
                "initial_device_display_name": "Concord Web",
            },
        )

        if resp.status_code != 200:
            error = resp.json()
            raise Exception(error.get("error", "Registration failed"))

        return resp.json()


async def join_room(access_token: str, room_id: str) -> None:
    """Join a Matrix room using the given access token.

    Only treats 200 as success. Raises on 403 (forbidden/banned)
    instead of silently swallowing it.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{MATRIX_HOMESERVER_URL}/_matrix/client/v3/join/{room_id}",
            headers={"Authorization": f"Bearer {access_token}"},
            json={},
        )
        if resp.status_code == 200:
            return
        if resp.status_code == 403:
            error_msg = resp.json().get("error", "Forbidden")
            raise Exception(f"Cannot join room: {error_msg}")
        resp.raise_for_status()


async def invite_to_room(access_token: str, room_id: str, user_id: str) -> None:
    """Invite a Matrix user to a room using the inviter's access token.

    Best-effort: silently ignores common "already a member" responses
    so callers can fan out invites to a member list without special-casing
    the user who created the room.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{MATRIX_HOMESERVER_URL}/_matrix/client/v3/rooms/{room_id}/invite",
            headers={"Authorization": f"Bearer {access_token}"},
            json={"user_id": user_id},
        )
        if resp.status_code == 200:
            return
        # M_FORBIDDEN with "already in the room" is fine — we want idempotency
        if resp.status_code == 403:
            try:
                err = resp.json().get("error", "") or ""
            except Exception:
                err = ""
            if "already" in err.lower():
                return
            raise Exception(f"Cannot invite {user_id} to room: {err or 'forbidden'}")
        resp.raise_for_status()


async def set_room_name(access_token: str, room_id: str, name: str) -> None:
    """Update the m.room.name state event on a Matrix room."""
    async with httpx.AsyncClient() as client:
        resp = await client.put(
            f"{MATRIX_HOMESERVER_URL}/_matrix/client/v3/rooms/{room_id}/state/m.room.name/",
            headers={"Authorization": f"Bearer {access_token}"},
            json={"name": name},
        )
        resp.raise_for_status()


async def create_dm_room(
    access_token: str,
    invite_user_id: str,
    user_id: Optional[str] = None,
) -> str:
    """Find-or-create a direct-message Matrix room and return the room ID.

    Matrix's ``POST /createRoom`` with ``is_direct: true`` is NOT idempotent:
    every call spawns a fresh room, and whether the invited user ends up
    joined depends on invite-acceptance timing. Flows that call this on
    every user action end up with a growing pile of orphan DM rooms — and
    the commands they send into the "new" DM land in a room the bot never
    joined.

    When ``user_id`` is provided we consult the caller's ``m.direct``
    account data for an existing DM with ``invite_user_id``, validate
    that both parties are still joined, and reuse it if so. Only fall
    through to ``createRoom`` if no valid existing DM is found, and
    register the newly-created room in ``m.direct`` so the next call
    finds it.

    ``user_id`` is optional for backwards compatibility — callers that
    don't have it still get the old create-only behaviour.
    """
    async with httpx.AsyncClient() as client:
        if user_id:
            existing = await _find_existing_dm(client, access_token, user_id, invite_user_id)
            if existing is not None:
                return existing

        resp = await client.post(
            f"{MATRIX_HOMESERVER_URL}/_matrix/client/v3/createRoom",
            headers={"Authorization": f"Bearer {access_token}"},
            json={
                "is_direct": True,
                "invite": [invite_user_id],
                "preset": "trusted_private_chat",
                "visibility": "private",
            },
        )
        resp.raise_for_status()
        data = resp.json()
        room_id = data.get("room_id")
        if not room_id:
            raise Exception(f"Matrix createRoom response missing room_id: {data}")

        if user_id:
            await _register_dm_in_account_data(
                client, access_token, user_id, invite_user_id, room_id,
            )

        return room_id


async def _find_existing_dm(
    client: httpx.AsyncClient,
    access_token: str,
    user_id: str,
    invite_user_id: str,
) -> Optional[str]:
    """Return a room id for an existing live DM with ``invite_user_id``,
    or None. A room counts as live if the homeserver still knows it
    (``/joined_members`` returns 200) AND both participants are listed
    as joined. Rooms where either side has left are skipped because
    sending into them produces messages the other party won't see.
    """
    encoded_user = quote(user_id, safe="")
    try:
        resp = await client.get(
            f"{MATRIX_HOMESERVER_URL}/_matrix/client/v3/user/{encoded_user}/account_data/m.direct",
            headers={"Authorization": f"Bearer {access_token}"},
        )
    except httpx.HTTPError:
        return None
    if resp.status_code != 200:
        return None
    try:
        m_direct = resp.json() or {}
    except ValueError:
        return None
    candidates = m_direct.get(invite_user_id) or []
    for room_id in candidates:
        if not isinstance(room_id, str):
            continue
        try:
            joined_resp = await client.get(
                f"{MATRIX_HOMESERVER_URL}/_matrix/client/v3/rooms/{quote(room_id, safe='')}/joined_members",
                headers={"Authorization": f"Bearer {access_token}"},
            )
        except httpx.HTTPError:
            continue
        if joined_resp.status_code != 200:
            continue
        try:
            joined = (joined_resp.json() or {}).get("joined", {}) or {}
        except ValueError:
            continue
        if invite_user_id in joined and user_id in joined:
            return room_id
    return None


async def _register_dm_in_account_data(
    client: httpx.AsyncClient,
    access_token: str,
    user_id: str,
    invite_user_id: str,
    room_id: str,
) -> None:
    """Add ``room_id`` under ``invite_user_id`` in the caller's
    ``m.direct`` account data. Idempotent — safe to call even if the
    room is already listed. Failures are swallowed because the primary
    operation (room creation) has already succeeded and the Matrix
    client-side sync will eventually repopulate ``m.direct`` from
    membership state anyway.
    """
    encoded_user = quote(user_id, safe="")
    existing: dict = {}
    try:
        resp = await client.get(
            f"{MATRIX_HOMESERVER_URL}/_matrix/client/v3/user/{encoded_user}/account_data/m.direct",
            headers={"Authorization": f"Bearer {access_token}"},
        )
        if resp.status_code == 200:
            body = resp.json() or {}
            if isinstance(body, dict):
                existing = body
    except (httpx.HTTPError, ValueError):
        existing = {}
    rooms = list(existing.get(invite_user_id) or [])
    if room_id in rooms:
        return
    rooms.append(room_id)
    existing[invite_user_id] = rooms
    try:
        await client.put(
            f"{MATRIX_HOMESERVER_URL}/_matrix/client/v3/user/{encoded_user}/account_data/m.direct",
            headers={"Authorization": f"Bearer {access_token}"},
            json=existing,
        )
    except httpx.HTTPError:
        pass


async def create_matrix_room(access_token: str, name: str) -> str:
    """Create a Matrix room and return the room ID.

    Uses public_chat preset so anyone with the room ID can join without
    needing an explicit invite. Access control is handled at the Concord
    server/invite layer instead.
    """
    async with httpx.AsyncClient() as client:
        resp = await client.post(
            f"{MATRIX_HOMESERVER_URL}/_matrix/client/v3/createRoom",
            headers={"Authorization": f"Bearer {access_token}"},
            json={
                "name": name,
                "visibility": "private",
                "preset": "public_chat",
            },
        )
        resp.raise_for_status()
        data = resp.json()
        room_id = data.get("room_id")
        if not room_id:
            raise Exception(f"Matrix createRoom response missing room_id: {data}")
        return room_id
