-- The generic layout with the default mapping (tables `nodes` and `edges`), for
-- MySQL 8.0.17 or newer. Text compares by code point (utf8mb4_bin), as in Cypher.
CREATE TABLE nodes (
  id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  labels json NOT NULL DEFAULT (JSON_ARRAY()) CHECK (JSON_TYPE(labels) = 'ARRAY'),
  properties json NOT NULL DEFAULT (JSON_OBJECT()) CHECK (JSON_TYPE(properties) = 'OBJECT')
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin;

CREATE TABLE edges (
  id bigint NOT NULL AUTO_INCREMENT PRIMARY KEY,
  start_id bigint NOT NULL,
  end_id bigint NOT NULL,
  type varchar(255) NOT NULL,
  properties json NOT NULL DEFAULT (JSON_OBJECT()) CHECK (JSON_TYPE(properties) = 'OBJECT'),
  FOREIGN KEY (start_id) REFERENCES nodes (id),
  FOREIGN KEY (end_id) REFERENCES nodes (id)
) DEFAULT CHARSET = utf8mb4 COLLATE = utf8mb4_bin;

-- Following relationships from either end, and filtering by type.
CREATE INDEX edges_start_id_type ON edges (start_id, type);
CREATE INDEX edges_end_id_type ON edges (end_id, type);
CREATE INDEX edges_type ON edges (type);

-- A declared integer or float property is read with the same expression as a
-- functional index on it (see Dialect.typedMember in src/dialect/mysql.ts):
--
--   CREATE INDEX nodes_age ON nodes ((CAST(JSON_EXTRACT(properties, '$."age"') AS SIGNED)));
--
-- MySQL does not use a functional index for a declared string property.
