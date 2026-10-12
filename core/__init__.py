"""
Ядро Lemko CRM.

Импортируй из подмодулей явно, чтобы не тянуть models при загрузке database:

    from core.config import settings
    from core.database import get_db, Base
    from core.security import hash_password
    from core.deps import get_current_user
    from core.auth import register_studio, authenticate_user
    from core.middleware import setup_core_middleware
"""

__all__: list[str] = []
