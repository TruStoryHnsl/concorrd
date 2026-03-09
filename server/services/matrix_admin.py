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
