// CONCORD PATCH: rename_tables migration is a no-op on Windows SQLite.
//
// The upstream migration runs `ALTER TABLE <old> RENAME TO <new>` for
// each pre-userapi-prefix table. On fresh Windows SQLite installs
// (Concord's Host onboarding flow always creates a fresh server) the
// pure-Go SQLite library used in cross-compiled Windows builds has
// stricter parsing than dendrite's migration framework expects, and
// the rename fails with "SQL logic error: near 'EXISTS': syntax
// error" — even though the user-written ALTER TABLE has no EXISTS
// keyword (the failure is in the migration framework's
// transaction-wrap or the bundled SQLite's table-rebuild check).
//
// Since Concord-bundled dendrite is always a fresh install, the
// rename migration is unnecessary: the post-migration schema's
// `CREATE TABLE IF NOT EXISTS userapi_*` statements produce the
// correct layout from scratch. Make Up/DownRenameTables a no-op so
// the migration tracking row is recorded as run and dendrite
// proceeds. Both functions are retained because storage.go references
// them by name in its migration registration list.
//
// This file is dropped over the upstream original by
// .github/workflows/build-dendrite-windows.yml before `go build`.
// Linux + Postgres builds are not affected (different deltas/ tree).

package deltas

import (
	"context"
	"database/sql"
)

func UpRenameTables(ctx context.Context, tx *sql.Tx) error {
	_ = ctx
	_ = tx
	return nil
}

func DownRenameTables(ctx context.Context, tx *sql.Tx) error {
	_ = ctx
	_ = tx
	return nil
}
