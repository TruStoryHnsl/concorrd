import secrets
from datetime import datetime, timedelta, timezone

from sqlalchemy import String, DateTime, Integer, Float, Boolean, ForeignKey, UniqueConstraint
from sqlalchemy.orm import Mapped, mapped_column, relationship

from database import Base


class Server(Base):
    __tablename__ = "servers"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: secrets.token_urlsafe(8))
    name: Mapped[str] = mapped_column(String, nullable=False)
    icon_url: Mapped[str | None] = mapped_column(String, nullable=True)
    owner_id: Mapped[str] = mapped_column(String, nullable=False)  # Matrix user ID
    visibility: Mapped[str] = mapped_column(String, default="private")  # "private" or "public"
    abbreviation: Mapped[str | None] = mapped_column(String(3), nullable=True)
    kick_limit: Mapped[int] = mapped_column(Integer, default=3)  # kicks before ban
    kick_window_minutes: Mapped[int] = mapped_column(Integer, default=30)  # window for kick counting
    ban_mode: Mapped[str] = mapped_column(String, default="soft")  # "soft", "harsh"
    media_uploads_enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # Place re-minting (ownership transfer) link. Set on the NEW place
    # record after a re-mint, pointing back to the place it inherited
    # from. NULL on the original record. See routers/servers.py
    # remint_ownership.
    previous_place_id: Mapped[str | None] = mapped_column(
        String, ForeignKey("servers.id"), nullable=True
    )
    bans_disposables: Mapped[bool] = mapped_column(Boolean, default=False)
    # Server rules/regulations text shown to new members before they can post.
    # NULL means no rules configured. Empty string is normalized to NULL.
    rules_text: Mapped[str | None] = mapped_column(String(2000), nullable=True, default=None)
    # Rolling auth code secret — used to generate the deterministic
    # 6-char alphabetic code that rotates every 10 minutes. All server
    # members see the same code; joining requires both an invite token
    # AND the current auth code. Auto-generated on first access.
    auth_code_secret: Mapped[str | None] = mapped_column(
        String, nullable=True, default=lambda: secrets.token_hex(32)
    )
    # INS-053: When True, non-admin members can create channels in this server.
    # Default False — only admins/owners can create channels.
    allow_user_channel_creation: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))

    channels: Mapped[list["Channel"]] = relationship(back_populates="server", cascade="all, delete-orphan")
    invites: Mapped[list["InviteToken"]] = relationship(back_populates="server", cascade="all, delete-orphan")
    members: Mapped[list["ServerMember"]] = relationship(back_populates="server", cascade="all, delete-orphan")
    bans: Mapped[list["ServerBan"]] = relationship(back_populates="server", cascade="all, delete-orphan")
    whitelist: Mapped[list["ServerWhitelist"]] = relationship(back_populates="server", cascade="all, delete-orphan")


class Channel(Base):
    __tablename__ = "channels"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    server_id: Mapped[str] = mapped_column(String, ForeignKey("servers.id"), nullable=False)
    matrix_room_id: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    name: Mapped[str] = mapped_column(String, nullable=False)
    channel_type: Mapped[str] = mapped_column(String, default="text")  # "text" or "voice"
    position: Mapped[int] = mapped_column(Integer, default=0)

    server: Mapped["Server"] = relationship(back_populates="channels")


class InviteToken(Base):
    __tablename__ = "invite_tokens"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    token: Mapped[str] = mapped_column(String, unique=True, nullable=False, default=lambda: secrets.token_urlsafe(16))
    server_id: Mapped[str] = mapped_column(String, ForeignKey("servers.id"), nullable=False)
    created_by: Mapped[str] = mapped_column(String, nullable=False)  # Matrix user ID
    expires_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=lambda: datetime.now(timezone.utc) + timedelta(days=7),
    )
    max_uses: Mapped[int] = mapped_column(Integer, default=10)
    use_count: Mapped[int] = mapped_column(Integer, default=0)
    permanent: Mapped[bool] = mapped_column(default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))

    server: Mapped["Server"] = relationship(back_populates="invites")

    @property
    def is_valid(self) -> bool:
        if self.permanent:
            return True
        now = datetime.now(timezone.utc)
        expires = self.expires_at.replace(tzinfo=timezone.utc) if self.expires_at.tzinfo is None else self.expires_at
        return self.use_count < self.max_uses and now < expires


class ServerMember(Base):
    __tablename__ = "server_members"
    __table_args__ = (
        UniqueConstraint("server_id", "user_id", name="uq_server_member"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    server_id: Mapped[str] = mapped_column(String, ForeignKey("servers.id"), nullable=False)
    user_id: Mapped[str] = mapped_column(String, nullable=False)  # Matrix user ID
    role: Mapped[str] = mapped_column(String, default="member")  # "owner", "admin", or "member"
    can_kick: Mapped[bool] = mapped_column(Boolean, default=False)
    can_ban: Mapped[bool] = mapped_column(Boolean, default=False)
    display_name: Mapped[str | None] = mapped_column(String, nullable=True)
    joined_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))

    server: Mapped["Server"] = relationship(back_populates="members")


class ServerBan(Base):
    __tablename__ = "server_bans"
    __table_args__ = (
        UniqueConstraint("server_id", "user_id", name="uq_server_ban"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    server_id: Mapped[str] = mapped_column(String, ForeignKey("servers.id"), nullable=False)
    user_id: Mapped[str] = mapped_column(String, nullable=False)  # Matrix user ID
    banned_by: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))

    server: Mapped["Server"] = relationship(back_populates="bans")


class ServerWhitelist(Base):
    __tablename__ = "server_whitelist"
    __table_args__ = (
        UniqueConstraint("server_id", "user_id", name="uq_server_whitelist"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    server_id: Mapped[str] = mapped_column(String, ForeignKey("servers.id"), nullable=False)
    user_id: Mapped[str] = mapped_column(String, nullable=False)  # Matrix user ID
    added_by: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))

    server: Mapped["Server"] = relationship(back_populates="whitelist")


class Webhook(Base):
    __tablename__ = "webhooks"

    id: Mapped[str] = mapped_column(String, primary_key=True, default=lambda: secrets.token_urlsafe(16))
    server_id: Mapped[str] = mapped_column(String, ForeignKey("servers.id"), nullable=False)
    channel_id: Mapped[int] = mapped_column(Integer, ForeignKey("channels.id"), nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    created_by: Mapped[str] = mapped_column(String, nullable=False)  # Matrix user ID
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))

    server: Mapped["Server"] = relationship()
    channel: Mapped["Channel"] = relationship()


class SoundboardClip(Base):
    __tablename__ = "soundboard_clips"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    server_id: Mapped[str] = mapped_column(String, ForeignKey("servers.id"), nullable=False)
    name: Mapped[str] = mapped_column(String, nullable=False)
    filename: Mapped[str] = mapped_column(String, nullable=False)  # stored filename on disk
    uploaded_by: Mapped[str] = mapped_column(String, nullable=False)  # Matrix user ID
    duration: Mapped[float | None] = mapped_column(Float, nullable=True)  # seconds
    keybind: Mapped[str | None] = mapped_column(String, nullable=True)  # e.g. "Alt+1"
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))

    server: Mapped["Server"] = relationship()


class DirectInvite(Base):
    __tablename__ = "direct_invites"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    server_id: Mapped[str] = mapped_column(String, ForeignKey("servers.id"), nullable=False)
    inviter_id: Mapped[str] = mapped_column(String, nullable=False)  # Matrix user ID
    invitee_id: Mapped[str] = mapped_column(String, nullable=False)  # Matrix user ID
    status: Mapped[str] = mapped_column(String, default="pending")  # pending, accepted, declined
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))

    server: Mapped["Server"] = relationship()


class VoiceSession(Base):
    __tablename__ = "voice_sessions"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String, nullable=False)
    channel_id: Mapped[str] = mapped_column(String, nullable=False)  # matrix_room_id
    server_id: Mapped[str] = mapped_column(String, ForeignKey("servers.id"), nullable=False)
    started_at: Mapped[datetime] = mapped_column(DateTime, nullable=False, default=lambda: datetime.now(timezone.utc))
    ended_at: Mapped[datetime | None] = mapped_column(DateTime, nullable=True)
    duration_seconds: Mapped[int | None] = mapped_column(Integer, nullable=True)


class DiscordVoiceBridge(Base):
    __tablename__ = "discord_voice_bridges"
    __table_args__ = (
        UniqueConstraint("matrix_room_id", name="uq_discord_voice_bridge_matrix_room"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    server_id: Mapped[str] = mapped_column(String, ForeignKey("servers.id"), nullable=False)
    channel_id: Mapped[int] = mapped_column(Integer, ForeignKey("channels.id"), nullable=False)
    matrix_room_id: Mapped[str] = mapped_column(String, nullable=False)
    discord_guild_id: Mapped[str] = mapped_column(String, nullable=False)
    discord_channel_id: Mapped[str] = mapped_column(String, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=True)
    # W4: video bridge expansion fields
    video_enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    projection_policy: Mapped[str] = mapped_column(String, default="screen_share_first")
    quality_cap: Mapped[str] = mapped_column(String, default="auto")
    audio_only_fallback: Mapped[bool] = mapped_column(Boolean, default=True)
    created_by: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))

    server: Mapped["Server"] = relationship()
    channel: Mapped["Channel"] = relationship()


class MessageCount(Base):
    __tablename__ = "message_counts"
    __table_args__ = (
        UniqueConstraint("user_id", "channel_id", "day", name="uq_message_count"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String, nullable=False)
    channel_id: Mapped[str] = mapped_column(String, nullable=False)  # matrix_room_id
    server_id: Mapped[str] = mapped_column(String, ForeignKey("servers.id"), nullable=False)
    day: Mapped[str] = mapped_column(String, nullable=False)  # YYYY-MM-DD
    count: Mapped[int] = mapped_column(Integer, default=0)


class ChannelLock(Base):
    __tablename__ = "channel_locks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    channel_id: Mapped[int] = mapped_column(Integer, ForeignKey("channels.id"), unique=True, nullable=False)
    pin_hash: Mapped[str] = mapped_column(String, nullable=False)  # hashed 4-digit PIN
    locked_by: Mapped[str] = mapped_column(String, nullable=False)  # Matrix user ID
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))


class VoteKick(Base):
    __tablename__ = "vote_kicks"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    server_id: Mapped[str] = mapped_column(String, ForeignKey("servers.id"), nullable=False)
    channel_id: Mapped[str] = mapped_column(String, nullable=False)  # matrix_room_id
    target_user_id: Mapped[str] = mapped_column(String, nullable=False)
    initiated_by: Mapped[str] = mapped_column(String, nullable=False)
    votes_yes: Mapped[str] = mapped_column(String, default="")  # comma-separated user IDs
    votes_no: Mapped[str] = mapped_column(String, default="")
    total_eligible: Mapped[int] = mapped_column(Integer, default=0)
    status: Mapped[str] = mapped_column(String, default="active")  # active, passed, failed, expired
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))


class KickRecord(Base):
    __tablename__ = "kick_records"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    server_id: Mapped[str] = mapped_column(String, ForeignKey("servers.id"), nullable=False)
    user_id: Mapped[str] = mapped_column(String, nullable=False)
    kicked_by: Mapped[str] = mapped_column(String, nullable=False)  # "vote" or user_id
    reason: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))


class IPBan(Base):
    __tablename__ = "ip_bans"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    ip_address: Mapped[str] = mapped_column(String, nullable=False)
    user_id: Mapped[str] = mapped_column(String, nullable=False)
    server_id: Mapped[str] = mapped_column(String, ForeignKey("servers.id"), nullable=False)
    banned_by: Mapped[str] = mapped_column(String, nullable=False)
    reason: Mapped[str | None] = mapped_column(String, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))


class UserTOTP(Base):
    __tablename__ = "user_totp"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_id: Mapped[str] = mapped_column(String, unique=True, nullable=False)
    secret: Mapped[str] = mapped_column(String, nullable=False)
    enabled: Mapped[bool] = mapped_column(Boolean, default=False)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))


class DMConversation(Base):
    __tablename__ = "dm_conversations"
    __table_args__ = (
        UniqueConstraint("user_a", "user_b", name="uq_dm_pair"),
    )

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    user_a: Mapped[str] = mapped_column(String, nullable=False)  # lexicographically smaller Matrix user ID
    user_b: Mapped[str] = mapped_column(String, nullable=False)  # lexicographically larger Matrix user ID
    matrix_room_id: Mapped[str] = mapped_column(String, nullable=False, unique=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))


class BugReport(Base):
    __tablename__ = "bug_reports"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    reported_by: Mapped[str] = mapped_column(String, nullable=False)  # Matrix user ID
    title: Mapped[str] = mapped_column(String, nullable=False)
    description: Mapped[str] = mapped_column(String, nullable=False)
    system_info: Mapped[str | None] = mapped_column(String, nullable=True)  # JSON blob
    status: Mapped[str] = mapped_column(String, default="open")  # open, in_progress, resolved, closed
    admin_notes: Mapped[str | None] = mapped_column(String, nullable=True)
    # INS-028: GitHub issue number when the bug report was successfully
    # mirrored to the concord repo. NULL when GITHUB_BUG_REPORT_TOKEN is
    # unset, when the GitHub API call failed (graceful-degradation path),
    # or when the report predates INS-028. The migration helper in
    # `database.py::_migrate_bug_reports_github_issue_number` adds this
    # column to existing SQLite databases on startup so pre-INS-028
    # deployments don't need to drop the table.
    github_issue_number: Mapped[int | None] = mapped_column(Integer, nullable=True)
    created_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc))
    updated_at: Mapped[datetime] = mapped_column(DateTime, default=lambda: datetime.now(timezone.utc), onupdate=lambda: datetime.now(timezone.utc))


class DisposableNode(Base):
    """A short-lived anonymous node session.

    Used by the disposable-anonymous-browsing pillar (PLAN.md). A
    disposable node has no email, no password, and no Matrix account —
    only a random session token. The node MUST contribute compute back
    to the network (the ``must_contribute_compute`` flag is a hint to
    the scheduler that this node is eligible for compute work). Place
    admins can ban disposable nodes per-place via
    ``Server.bans_disposables``.
    """

    __tablename__ = "disposable_nodes"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    session_token: Mapped[str] = mapped_column(
        String, unique=True, nullable=False,
        default=lambda: secrets.token_urlsafe(32),
    )
    temp_identifier: Mapped[str] = mapped_column(
        String, nullable=False,
        default=lambda: f"anon-{secrets.token_urlsafe(8)}",
    )
    is_disposable: Mapped[bool] = mapped_column(Boolean, default=True)
    must_contribute_compute: Mapped[bool] = mapped_column(Boolean, default=True)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )
    expires_at: Mapped[datetime] = mapped_column(
        DateTime,
        default=lambda: datetime.now(timezone.utc) + timedelta(hours=24),
    )
    revoked: Mapped[bool] = mapped_column(Boolean, default=False)


class PlaceLedgerHeader(Base):
    """Compressed snapshot of a place ledger after a re-mint.

    On ownership re-mint we compress the previous place's ledger
    (channels, members, media filenames) into a single header row that
    is preserved alongside the new place. The header is either:

    - encrypted (``encrypted=True``): the JSON blob is base64-of-encrypted
      bytes that only an authorized key can decode. Used for
      privacy-preserving ownership transfer.
    - unencrypted (``encrypted=False``): the JSON blob is plaintext base64,
      visible to anyone with DB access. Matches the "flexible,
      committee-changeable" branch of the design.

    NB: The actual media files are NOT in this header — only their
    filenames. Media itself is stored on disk under SOUNDBOARD_DIR.
    """

    __tablename__ = "place_ledger_headers"

    id: Mapped[int] = mapped_column(Integer, primary_key=True, autoincrement=True)
    new_place_id: Mapped[str] = mapped_column(
        String, ForeignKey("servers.id"), nullable=False
    )
    previous_place_id: Mapped[str] = mapped_column(String, nullable=False)
    encrypted: Mapped[bool] = mapped_column(Boolean, default=False)
    payload: Mapped[str] = mapped_column(String, nullable=False)  # base64 JSON
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )


class UserDiscordOAuth(Base):
    """Per-user Discord OAuth2 state.

    One row per Concord user who has completed the "Sign in with Discord"
    flow. Stores the OAuth access / refresh tokens so we can hit Discord's
    REST API on the caller's behalf (for guilds list, profile, etc).

    Privacy note: tokens are stored in plaintext in the SQLite DB on the
    instance data volume, same trust boundary as the rest of user data.
    A future PR can move them behind an instance-keyed KDF once we have a
    persistent secret to derive with. Calling this out so no one assumes
    they're encrypted-at-rest today.

    Why the Discord user id is indexed: prevents two Concord accounts from
    claiming the same Discord identity at the same time. The OAuth flow
    enforces this on upsert by swapping the row to the new Concord user
    rather than silently dropping the collision.
    """

    __tablename__ = "user_discord_oauth"

    # Matrix MXID — the Concord user this token belongs to.
    user_id: Mapped[str] = mapped_column(String, primary_key=True)
    # Discord snowflake of the linked account.
    discord_user_id: Mapped[str] = mapped_column(String, nullable=False, index=True)
    discord_username: Mapped[str] = mapped_column(String, nullable=False)
    discord_global_name: Mapped[str | None] = mapped_column(String, nullable=True)
    discord_avatar: Mapped[str | None] = mapped_column(String, nullable=True)
    access_token: Mapped[str] = mapped_column(String, nullable=False)
    refresh_token: Mapped[str | None] = mapped_column(String, nullable=True)
    expires_at: Mapped[datetime] = mapped_column(DateTime, nullable=False)
    scope: Mapped[str] = mapped_column(String, nullable=False)
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )
    updated_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )


class DiscordOAuthState(Base):
    """Short-lived CSRF-guarding state tokens for the Discord OAuth flow.

    Each row represents a pending authorization: it ties a random ``state``
    parameter (sent to Discord in /oauth/authorize) back to the Concord
    user who initiated the flow. When Discord redirects to our callback,
    we look up the state, verify it's unexpired, and delete it.

    Rows older than 10 minutes are considered expired and ignored; a
    periodic cleanup could sweep them but the table stays tiny so it's
    not essential.
    """

    __tablename__ = "discord_oauth_state"

    state: Mapped[str] = mapped_column(String, primary_key=True)
    user_id: Mapped[str] = mapped_column(String, nullable=False)
    # Where to send the user after a successful callback. Bounded by a
    # same-origin check in the callback handler to prevent open-redirect.
    return_to: Mapped[str] = mapped_column(String, nullable=False, default="/")
    created_at: Mapped[datetime] = mapped_column(
        DateTime, default=lambda: datetime.now(timezone.utc)
    )
