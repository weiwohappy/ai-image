BEGIN;

ALTER TABLE inspirations
  ADD COLUMN editorial_label text,
  ADD COLUMN base_likes integer NOT NULL DEFAULT 0 CHECK (base_likes >= 0);

ALTER TABLE remix_templates
  ADD COLUMN popularity_label text,
  ADD COLUMN base_remix_count integer NOT NULL DEFAULT 0 CHECK (base_remix_count >= 0);

ALTER TABLE tool_definitions
  ADD COLUMN is_new boolean NOT NULL DEFAULT false;

COMMIT;
