-- STR-131: the BulletinPost foundation (Communication spec) -- the society
-- and project bulletin boards every other E14 story reads or writes, plus
-- the attachment links into the E12 document registry. No society_id --
-- single society per deployment. Purely additive (new tables only) -- no
-- `-- contract-migration:` annotation needed (see aws-blocks/migrations-lint.ts).
--
-- "Posts are archived, never deleted" (Communication, bundle-wide rule) is
-- structural here: `archived`/`archived_at` carry the state and there is no
-- DELETE path in this file or in aws-blocks/communication/bulletin-posts.ts.
-- `pinned` is a flag independent of that state, not a third lifecycle value.

CREATE TABLE bulletin_posts (
  id TEXT PRIMARY KEY,
  scope TEXT NOT NULL CHECK (scope IN ('society', 'project')),
  -- Society posts carry no project_id; project posts always do (Communication:
  -- "project posts carry `project_id`"). The CHECK makes the pairing an
  -- invariant of the table, not just of the write path (STR-131 T-U4).
  project_id TEXT REFERENCES projects (id),
  author_member_id TEXT NOT NULL REFERENCES members (id),
  title TEXT NOT NULL,
  body TEXT NOT NULL,
  pinned BOOLEAN NOT NULL DEFAULT false,
  posted_at TIMESTAMPTZ NOT NULL DEFAULT now(),
  -- Edits are audited (Communication): who last edited and when, both NULL
  -- until the first edit.
  editor_member_id TEXT REFERENCES members (id),
  edited_at TIMESTAMPTZ,
  archived BOOLEAN NOT NULL DEFAULT false,
  archived_at TIMESTAMPTZ,
  CONSTRAINT bulletin_posts_scope_project CHECK (
    (scope = 'society' AND project_id IS NULL) OR (scope = 'project' AND project_id IS NOT NULL)
  )
);

CREATE INDEX bulletin_posts_board ON bulletin_posts (scope, project_id, archived);

-- Attachments are document-registry references (Communication: "via the
-- document registry"), never file keys of their own. No FK to `documents`:
-- the registry is reached through an injectable lookup port in the module
-- above, so this table records the validated id rather than re-deciding
-- validity at the storage layer.
CREATE TABLE bulletin_post_attachments (
  post_id TEXT NOT NULL REFERENCES bulletin_posts (id),
  document_id TEXT NOT NULL,
  PRIMARY KEY (post_id, document_id)
);
