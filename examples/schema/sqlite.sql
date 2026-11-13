-- The generic layout with the default mapping (tables `nodes` and `edges`).
CREATE TABLE nodes (
  id INTEGER PRIMARY KEY,
  labels TEXT NOT NULL DEFAULT '[]' CHECK (json_type(labels) = 'array'),
  properties TEXT NOT NULL DEFAULT '{}' CHECK (json_type(properties) = 'object')
);

CREATE TABLE edges (
  id INTEGER PRIMARY KEY,
  start_id INTEGER NOT NULL REFERENCES nodes (id),
  end_id INTEGER NOT NULL REFERENCES nodes (id),
  type TEXT NOT NULL,
  properties TEXT NOT NULL DEFAULT '{}' CHECK (json_type(properties) = 'object')
);

-- Following relationships from either end, and filtering by type.
CREATE INDEX edges_start_id_type ON edges (start_id, type);
CREATE INDEX edges_end_id_type ON edges (end_id, type);
CREATE INDEX edges_type ON edges (type);
