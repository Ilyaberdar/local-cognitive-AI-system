ALTER TABLE identity_links ADD COLUMN display_name text
  CHECK (display_name IS NULL OR char_length(display_name) <= 200);
