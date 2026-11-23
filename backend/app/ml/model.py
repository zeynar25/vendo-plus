"""Load the trained model only if it is exactly the file that was selected and evaluated."""

import hashlib
import json
from dataclasses import dataclass
from pathlib import Path
from typing import Any

import joblib
import pandas as pd
import sklearn


class ModelIntegrityError(RuntimeError):
    """The model file, library version, or feature order does not match selection.json."""


@dataclass(frozen=True)
class LoadedModel:
    estimator: Any
    algorithm: str
    feature_columns: list[str]
    labels: list[str]
    sha256: str
    sklearn_version: str

    def predict(self, features: dict[str, float]) -> str:
        row = pd.DataFrame([[features[c] for c in self.feature_columns]], columns=self.feature_columns)
        return str(self.estimator.predict(row)[0])


def file_sha256(path: Path) -> str:
    digest = hashlib.sha256()
    with open(path, "rb") as handle:
        for block in iter(lambda: handle.read(1 << 20), b""):
            digest.update(block)
    return digest.hexdigest()


def load_model(model_dir: Path) -> LoadedModel:
    selection = json.loads((Path(model_dir) / "selection.json").read_text(encoding="utf-8"))
    algorithm = selection["final_model"]
    entry = selection["kept_per_algorithm"][algorithm]
    path = Path(model_dir) / f"{algorithm}.joblib"

    actual_hash = file_sha256(path)
    if actual_hash != entry["model_sha256"]:
        raise ModelIntegrityError(f"{path.name} hash {actual_hash[:12]} does not match selection.json "
                                  f"({entry['model_sha256'][:12]})")
    if sklearn.__version__ != selection["scikit_learn_version"]:
        raise ModelIntegrityError(f"scikit-learn {sklearn.__version__} installed, model was trained "
                                  f"with {selection['scikit_learn_version']}")

    estimator = joblib.load(path)
    columns = list(selection["feature_columns_in_order"])
    trained_columns = list(getattr(estimator, "feature_names_in_", columns))
    if trained_columns != columns:
        raise ModelIntegrityError("feature order in the model differs from selection.json")
    if set(estimator.classes_) != set(selection["labels"]):
        raise ModelIntegrityError("model classes differ from selection.json labels")

    return LoadedModel(estimator=estimator, algorithm=algorithm, feature_columns=columns,
                       labels=list(selection["labels"]), sha256=actual_hash,
                       sklearn_version=sklearn.__version__)
