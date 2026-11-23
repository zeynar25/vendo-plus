import json
import shutil
from pathlib import Path

import pytest
from fastapi.testclient import TestClient

from app.config import BACKEND_DIR, Settings
from app.main import create_app
from app.ml.model import ModelIntegrityError, load_model

MODEL_DIR = BACKEND_DIR / "model"
CASES = json.loads((Path(__file__).parent / "fixtures" / "model_cases.json").read_text())


def test_selected_random_forest_loads_and_passes_its_hash_check():
    model = load_model(MODEL_DIR)
    assert model.algorithm == "random_forest"
    assert model.sha256 == "768aaa18831a278afa4e9c82fee477667fdccaf7d12c94bd4e0b3ab1e60d664e"
    assert model.feature_columns[0] == "stock_ratio" and len(model.feature_columns) == 11


def test_predictions_match_the_offline_pipeline():
    # Expected labels were produced by ml/ on the same test-period rows.
    model = load_model(MODEL_DIR)
    for case in CASES:
        assert model.predict(case["features"]) == case["expected"], case["decision_time"]


def test_a_changed_model_file_is_refused(tmp_path):
    for name in ("selection.json", "random_forest.joblib"):
        shutil.copy(MODEL_DIR / name, tmp_path / name)
    with open(tmp_path / "random_forest.joblib", "ab") as handle:
        handle.write(b"\0")
    with pytest.raises(ModelIntegrityError, match="hash"):
        load_model(tmp_path)


def test_a_different_scikit_learn_version_is_refused(tmp_path):
    shutil.copy(MODEL_DIR / "random_forest.joblib", tmp_path / "random_forest.joblib")
    selection = json.loads((MODEL_DIR / "selection.json").read_text())
    selection["scikit_learn_version"] = "0.0.1"
    (tmp_path / "selection.json").write_text(json.dumps(selection))
    with pytest.raises(ModelIntegrityError, match="scikit-learn"):
        load_model(tmp_path)


def test_service_still_starts_when_the_model_is_missing(tmp_path, settings):
    broken = settings.model_copy(update={"model_dir": tmp_path})
    with TestClient(create_app(broken)) as client:
        assert client.get("/healthz").status_code == 200
        assert client.app.state.model is None
        assert "FileNotFoundError" in client.app.state.model_error
