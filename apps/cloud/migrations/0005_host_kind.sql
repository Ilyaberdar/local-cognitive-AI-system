-- What kind of computer a host is, so a device can name it (a Mac, a PC, a server) before it
-- connects. Both may be missing: a host that registered before this says nothing about itself.
ALTER TABLE hosts
  ADD COLUMN kind text CHECK (kind IN ('server', 'desktop')),
  ADD COLUMN platform text CHECK (platform IN ('linux', 'macos', 'windows'));
