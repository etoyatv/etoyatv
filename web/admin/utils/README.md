# admin/utils (unused at runtime)

Docker Compose for the admin app mounts `../utils` (parent `web/utils`) over `/app/utils`.
These local files are therefore shadowed and not loaded in the container.

Prefer shared helpers under `web/utils/` instead of duplicating here.
