"""All settings in one place, read from environment variables (or a local .env file).

On Render, set DATABASE_URL (and optionally OPERATOR_KEY) in the service's
Environment tab. Every other value has a default that matches the paper.
"""

from pathlib import Path

from pydantic_settings import BaseSettings, SettingsConfigDict

BACKEND_DIR = Path(__file__).resolve().parents[1]


class Settings(BaseSettings):
    model_config = SettingsConfigDict(env_file=".env", extra="ignore", protected_namespaces=())

    # Supabase: use the "Session pooler" connection string (IPv4). Local default: a SQLite file.
    database_url: str = "sqlite:///./vendoplus-dev.db"
    # Create missing tables at startup (safe to leave on: existing tables are never changed).
    auto_create_tables: bool = True
    # When not empty, every operator action (POST from the dashboard) needs header X-Operator-Key.
    operator_key: str = ""
    # Comma-separated list of origins allowed to call the API from a browser ("*" = any).
    cors_origins: str = "*"
    # Machines' local time zone, used for the hour and weekday features.
    timezone: str = "Asia/Manila"
    # Folder with the trained model and its selection record.
    model_dir: Path = BACKEND_DIR / "model"

    # Freshness rules from the paper (seconds).
    stale_after_s: float = 10.0
    offline_after_s: float = 15.0
    # A prediction row is stored when the urgency changes, and at least this often.
    prediction_log_interval_s: float = 3600.0
    # Replay mode: real seconds between simulated readings.
    replay_tick_s: float = 5.0
    # Run the replay background loop inside the web process.
    enable_replay_runner: bool = True

    @property
    def cors_origin_list(self) -> list[str]:
        return [o.strip() for o in self.cors_origins.split(",") if o.strip()]


def get_settings() -> Settings:
    return Settings()
