"""
Tests for search_report.py: the one-setting-at-a-time sweeps behind the search
range table and figure. They use a small made-up validation table.

Run from the project folder:
    python -m pytest -v
"""

import json

import pandas as pd
import pytest

import search_report

KEPT = {
    "logistic_regression": {"C": 1},
    "random_forest": {"n_estimators": 200, "max_depth": 16, "min_samples_leaf": 20},
    "hist_gradient_boosting": {"max_leaf_nodes": 31, "learning_rate": 0.05},
}


def make_table():
    rows = []

    def add(algorithm, params, f1, within=True):
        rows.append({"algorithm": algorithm, "params": params, "macro_f1": f1, "within_size_limit": within})

    for c, f1 in [(0.01, 0.60), (1, 0.70), (100, 0.69)]:
        add("logistic_regression", {"C": c}, f1)
    for n in [100, 200]:
        for d in [8, 16]:
            for leaf in [5, 20]:
                f1 = 0.70 if (n, d, leaf) == (200, 16, 20) else 0.69 - 0.001 * leaf / 5
                add("random_forest", {"n_estimators": n, "max_depth": d, "min_samples_leaf": leaf}, f1,
                    within=leaf != 5)
    for m in [15, 31]:
        for lr in [0.05, 0.1]:
            add("hist_gradient_boosting", {"max_leaf_nodes": m, "learning_rate": lr},
                0.70 if (m, lr) == (31, 0.05) else 0.68)
    return pd.DataFrame(rows)


def test_sweep_holds_the_other_settings_at_the_kept_values():
    rows = search_report.sweep(make_table(), KEPT, "random_forest", "min_samples_leaf")
    assert list(rows["value"]) == [5, 20]
    assert all(p["n_estimators"] == 200 and p["max_depth"] == 16 for p in rows["params"])


def test_search_range_reports_lowest_kept_and_highest():
    summary = search_report.search_range(make_table(), KEPT).set_index("setting")
    c = summary.loc["C"]
    assert (c["lowest"], c["kept"], c["highest"]) == ("0.01", "1", "100")
    assert (c["macro_f1_lowest"], c["macro_f1_kept"], c["macro_f1_highest"]) == (0.60, 0.70, 0.69)
    assert c["kept_value_is"] == "inside the range"
    assert summary.loc["n_estimators", "kept_value_is"] == "highest value tried"
    assert summary.loc["learning_rate", "kept_value_is"] == "lowest value tried"
    assert not summary.loc["min_samples_leaf", "lowest_within_size_limit"]


def test_missing_kept_value_is_refused():
    table = make_table()
    table = table[~((table["algorithm"] == "logistic_regression") & (table["params"] == {"C": 1}))]
    with pytest.raises(ValueError, match="missing"):
        search_report.sweep(table, KEPT, "logistic_regression", "C")


def test_report_writes_the_table_and_the_figure(tmp_path):
    table = make_table()
    results = tmp_path / "validation_results.csv"
    table.assign(params=table["params"].astype(str)).to_csv(results, index=False)
    selection = tmp_path / "selection.json"
    selection.write_text(json.dumps({"configurations": len(table),
                                     "kept_per_algorithm": {a: {"params": p} for a, p in KEPT.items()}}))
    summary = search_report.run_report(results, selection, tmp_path / "range.csv", tmp_path / "fig.png")
    assert len(summary) == 6
    assert (tmp_path / "range.csv").exists() and (tmp_path / "fig.png").stat().st_size > 10_000


def test_row_count_must_match_the_selection_record(tmp_path):
    table = make_table()
    results = tmp_path / "validation_results.csv"
    table.assign(params=table["params"].astype(str)).to_csv(results, index=False)
    selection = tmp_path / "selection.json"
    selection.write_text(json.dumps({"configurations": len(table) + 1, "kept_per_algorithm": {}}))
    with pytest.raises(ValueError, match="train.py"):
        search_report.load_results(results, selection)
