from main import LOBBY_WELCOME_POST_VERSION, build_lobby_welcome_message


def test_lobby_welcome_message_uses_markdown_sections() -> None:
    message = build_lobby_welcome_message("Concorrd")

    assert LOBBY_WELCOME_POST_VERSION >= 2
    assert message.startswith("# Welcome to Concorrd")
    assert "## Start here" in message
    assert "| Area | What it controls |" in message
    assert "- `inline code` for names and commands" in message
