BEGIN;

CREATE TABLE content_media (
  id uuid PRIMARY KEY,
  external_id text NOT NULL UNIQUE CHECK (length(external_id) BETWEEN 1 AND 160),
  object_key text NOT NULL UNIQUE CHECK (length(object_key) BETWEEN 1 AND 1024),
  sha256 text NOT NULL CHECK (sha256 ~ '^[a-f0-9]{64}$'),
  content_type text NOT NULL CHECK (content_type IN ('image/jpeg', 'image/png', 'image/webp')),
  width integer NOT NULL CHECK (width BETWEEN 1 AND 40000),
  height integer NOT NULL CHECK (height BETWEEN 1 AND 40000),
  byte_size integer NOT NULL CHECK (byte_size BETWEEN 1 AND 100663296),
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'offline', 'archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  published_at timestamptz(6),
  created_by_admin_id uuid REFERENCES "AdminAccount"(id) ON DELETE RESTRICT,
  updated_by_admin_id uuid REFERENCES "AdminAccount"(id) ON DELETE RESTRICT,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  CONSTRAINT content_media_safe_pixels CHECK ((width::bigint * height::bigint) <= 40000000)
);
CREATE INDEX content_media_status_created_at_id_idx ON content_media(status, created_at, id);

CREATE TABLE inspirations (
  id uuid PRIMARY KEY,
  external_id text NOT NULL UNIQUE CHECK (length(external_id) BETWEEN 1 AND 160),
  title text NOT NULL,
  description text NOT NULL,
  category text NOT NULL,
  creator_name text,
  source_type text,
  source_name text,
  source_url text,
  tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  default_prompt text NOT NULL,
  default_model_id text NOT NULL,
  default_output_spec_id text NOT NULL,
  cover_media_id uuid REFERENCES content_media(id) ON DELETE RESTRICT,
  case_media_id uuid REFERENCES content_media(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'offline', 'archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  published_at timestamptz(6),
  created_by_admin_id uuid REFERENCES "AdminAccount"(id) ON DELETE RESTRICT,
  updated_by_admin_id uuid REFERENCES "AdminAccount"(id) ON DELETE RESTRICT,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX inspirations_status_sort_order_id_idx ON inspirations(status, sort_order, id);
CREATE INDEX inspirations_cover_media_id_idx ON inspirations(cover_media_id);
CREATE INDEX inspirations_case_media_id_idx ON inspirations(case_media_id);

CREATE TABLE inspiration_likes (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  inspiration_id uuid NOT NULL REFERENCES inspirations(id) ON DELETE RESTRICT,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, inspiration_id)
);
CREATE INDEX inspiration_likes_inspiration_id_created_at_idx ON inspiration_likes(inspiration_id, created_at);

CREATE TABLE remix_templates (
  id uuid PRIMARY KEY,
  external_id text NOT NULL UNIQUE CHECK (length(external_id) BETWEEN 1 AND 160),
  title text NOT NULL,
  description text NOT NULL,
  category text NOT NULL,
  platform text NOT NULL,
  industry text NOT NULL,
  style text NOT NULL,
  creator_name text,
  source_type text,
  source_name text,
  source_url text,
  tags text[] NOT NULL DEFAULT ARRAY[]::text[],
  visual_analysis jsonb NOT NULL,
  default_prompt text NOT NULL,
  default_parameters jsonb NOT NULL,
  default_model_id text NOT NULL,
  default_output_spec_id text NOT NULL,
  cover_media_id uuid REFERENCES content_media(id) ON DELETE RESTRICT,
  reference_media_id uuid REFERENCES content_media(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'offline', 'archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  published_at timestamptz(6),
  created_by_admin_id uuid REFERENCES "AdminAccount"(id) ON DELETE RESTRICT,
  updated_by_admin_id uuid REFERENCES "AdminAccount"(id) ON DELETE RESTRICT,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX remix_templates_status_sort_order_id_idx ON remix_templates(status, sort_order, id);
CREATE INDEX remix_templates_cover_media_id_idx ON remix_templates(cover_media_id);
CREATE INDEX remix_templates_reference_media_id_idx ON remix_templates(reference_media_id);

CREATE TABLE remix_template_favorites (
  user_id uuid NOT NULL REFERENCES users(id) ON DELETE RESTRICT,
  remix_template_id uuid NOT NULL REFERENCES remix_templates(id) ON DELETE RESTRICT,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  PRIMARY KEY (user_id, remix_template_id)
);
CREATE INDEX remix_template_favorites_remix_template_id_created_at_idx
  ON remix_template_favorites(remix_template_id, created_at);

CREATE TABLE tool_definitions (
  id uuid PRIMARY KEY,
  external_id text NOT NULL UNIQUE CHECK (length(external_id) BETWEEN 1 AND 160),
  name text NOT NULL,
  description text NOT NULL,
  category text NOT NULL,
  creator_name text,
  source_type text,
  source_name text,
  source_url text,
  field_schema jsonb NOT NULL,
  prompt_template text NOT NULL,
  defaults jsonb NOT NULL,
  max_assets integer NOT NULL CHECK (max_assets BETWEEN 0 AND 4),
  max_output_count integer NOT NULL DEFAULT 1 CHECK (max_output_count BETWEEN 1 AND 4),
  asset_label text NOT NULL,
  default_model_id text NOT NULL,
  default_output_spec_id text NOT NULL,
  cover_media_id uuid REFERENCES content_media(id) ON DELETE RESTRICT,
  icon_media_id uuid REFERENCES content_media(id) ON DELETE RESTRICT,
  status text NOT NULL DEFAULT 'draft' CHECK (status IN ('draft', 'published', 'offline', 'archived')),
  version integer NOT NULL DEFAULT 1 CHECK (version >= 1),
  sort_order integer NOT NULL DEFAULT 0 CHECK (sort_order >= 0),
  published_at timestamptz(6),
  created_by_admin_id uuid REFERENCES "AdminAccount"(id) ON DELETE RESTRICT,
  updated_by_admin_id uuid REFERENCES "AdminAccount"(id) ON DELETE RESTRICT,
  created_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP,
  updated_at timestamptz(6) NOT NULL DEFAULT CURRENT_TIMESTAMP
);
CREATE INDEX tool_definitions_status_sort_order_id_idx ON tool_definitions(status, sort_order, id);
CREATE INDEX tool_definitions_cover_media_id_idx ON tool_definitions(cover_media_id);
CREATE INDEX tool_definitions_icon_media_id_idx ON tool_definitions(icon_media_id);

COMMIT;
