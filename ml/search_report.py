"""
search_report.py - how validation macro F1 changes across each setting's range.

Reads the validation results and the selection record that train.py wrote and
writes two files to results/:

    search_range.csv            one row per setting: the values tried, and the
                                validation macro F1 at the lowest, kept and
                                highest value, with the algorithm's other
                                settings held at the kept configuration
    validation_sensitivity.png  the same sweeps as one panel per setting; the
                                kept value is marked, and configurations over
                                the model size limit (D-40) are drawn hollow

Only validation results are read; the test partition is never loaded.

How to run (from the project folder, after train.py):
    python search_report.py
"""

import ast
import json

import matplotlib
matplotlib.use("Agg")
import matplotlib.pyplot as plt
import pandas as pd
from matplotlib.ticker import FormatStrFormatter, MaxNLocator

import config
from pipeline_utils import save_csv

# (algorithm, setting, panel title), in the order of Table 9.
SETTINGS = [
    ("logistic_regression", "C", "Logistic Regression: C"),
    ("random_forest", "n_estimators", "Random Forest: trees"),
    ("random_forest", "max_depth", "Random Forest: maximum depth"),
    ("random_forest", "min_samples_leaf", "Random Forest: minimum leaf size"),
    ("hist_gradient_boosting", "max_leaf_nodes", "Gradient boosting: maximum leaf nodes"),
    ("hist_gradient_boosting", "learning_rate", "Gradient boosting: learning rate"),
]


def value_text(value):
    """0.0001 -> '0.0001', 10000 -> '10000', 0.05 -> '0.05'."""
    return f"{value:g}"


def load_results(results_path=config.VALIDATION_RESULTS_PATH, selection_path=config.SELECTION_PATH):
    """The validation table (params as dicts) and the kept configuration of each algorithm."""
    table = pd.read_csv(results_path)
    table["params"] = table["params"].apply(ast.literal_eval)
    with open(selection_path, encoding="utf-8") as f:
        selection = json.load(f)
    if len(table) != selection["configurations"]:
        raise ValueError(f"{results_path} has {len(table)} rows, but {selection_path} records "
                         f"{selection['configurations']} configurations. Run train.py again.")
    kept = {algorithm: info["params"] for algorithm, info in selection["kept_per_algorithm"].items()}
    return table, kept


def sweep(table, kept, algorithm, setting):
    """The algorithm's rows whose other settings equal the kept configuration, by setting value."""
    base = kept[algorithm]
    rows = table[table["algorithm"] == algorithm]
    same_otherwise = rows["params"].apply(
        lambda p: all(p.get(name) == value for name, value in base.items() if name != setting))
    rows = rows[same_otherwise]
    rows = rows.assign(value=rows["params"].apply(lambda p: p[setting])).sort_values("value")
    if base[setting] not in set(rows["value"]):
        raise ValueError(f"The kept {algorithm} value of {setting} is missing from the results.")
    return rows.reset_index(drop=True)


def search_range(table, kept):
    """One row per setting: lowest, kept and highest value with their validation macro F1."""
    out = []
    for algorithm, setting, _ in SETTINGS:
        rows = sweep(table, kept, algorithm, setting)
        low, high = rows.iloc[0], rows.iloc[-1]
        kept_row = rows[rows["value"] == kept[algorithm][setting]].iloc[0]
        if kept_row["value"] == low["value"]:
            position = "lowest value tried"
        elif kept_row["value"] == high["value"]:
            position = "highest value tried"
        else:
            position = "inside the range"
        out.append({
            "algorithm": algorithm, "setting": setting,
            "values_tried": ", ".join(value_text(v) for v in rows["value"]),
            "lowest": value_text(low["value"]), "macro_f1_lowest": round(low["macro_f1"], 4),
            "lowest_within_size_limit": bool(low["within_size_limit"]),
            "kept": value_text(kept_row["value"]), "macro_f1_kept": round(kept_row["macro_f1"], 4),
            "highest": value_text(high["value"]), "macro_f1_highest": round(high["macro_f1"], 4),
            "highest_within_size_limit": bool(high["within_size_limit"]),
            "kept_value_is": position,
        })
    return pd.DataFrame(out)


def plot_sensitivity(table, kept, path):
    blue, orange = "#2a78d6", "#eb6834"
    fig, axes = plt.subplots(3, 2, figsize=(8, 7.2), dpi=200)
    for ax, (algorithm, setting, title) in zip(axes.flat, SETTINGS):
        rows = sweep(table, kept, algorithm, setting)
        x = range(len(rows))
        ax.plot(x, rows["macro_f1"], color=blue, lw=1.5, zorder=1)
        for xi, (_, r) in zip(x, rows.iterrows()):
            is_kept = r["value"] == kept[algorithm][setting]
            ax.scatter(xi, r["macro_f1"], s=70 if is_kept else 28, zorder=2, linewidths=1.5,
                       color=orange if is_kept else (blue if r["within_size_limit"] else "white"),
                       edgecolors=orange if is_kept else blue)
        ax.set_xticks(list(x), [value_text(v) for v in rows["value"]], fontsize=7)
        ax.tick_params(axis="y", labelsize=7)
        ax.yaxis.set_major_locator(MaxNLocator(nbins=4))
        ax.yaxis.set_major_formatter(FormatStrFormatter("%.4f"))
        ax.set_title(title, fontsize=8)
        ax.grid(axis="y", color="#e1e0d9", lw=0.6)
        for side in ["top", "right"]:
            ax.spines[side].set_visible(False)
    for ax in axes[:, 0]:
        ax.set_ylabel("Validation macro F1", fontsize=7)
    handles = [
        plt.Line2D([], [], marker="o", ls="", color=orange, markersize=8, label="Kept value"),
        plt.Line2D([], [], marker="o", ls="", color=blue, markersize=5, label="Other values"),
        plt.Line2D([], [], marker="o", ls="", markerfacecolor="white", markeredgecolor=blue, markersize=5,
                   label=f"Over the {config.MAX_MODEL_MB:g} MB size limit (not eligible)"),
    ]
    fig.legend(handles=handles, loc="lower center", ncol=3, fontsize=7, frameon=False)
    fig.tight_layout(rect=(0, 0.04, 1, 1))
    path.parent.mkdir(parents=True, exist_ok=True)
    fig.savefig(path, facecolor="white")
    plt.close(fig)


def run_report(results_path=config.VALIDATION_RESULTS_PATH, selection_path=config.SELECTION_PATH,
               table_path=config.SEARCH_RANGE_PATH, figure_path=config.SENSITIVITY_FIGURE_PATH):
    table, kept = load_results(results_path, selection_path)
    summary = search_range(table, kept)
    save_csv(summary, table_path)
    plot_sensitivity(table, kept, figure_path)
    return summary


def main():
    summary = run_report()
    print(f"{len(summary)} settings written to {config.SEARCH_RANGE_PATH.name} and "
          f"{config.SENSITIVITY_FIGURE_PATH.name}")
    for _, r in summary.iterrows():
        print(f"  {r['algorithm']:24s} {r['setting']:17s} {r['lowest']:>7s} {r['macro_f1_lowest']:.4f}  "
              f"kept {r['kept']:>5s} {r['macro_f1_kept']:.4f}  {r['highest']:>6s} {r['macro_f1_highest']:.4f}  "
              f"({r['kept_value_is']})")


if __name__ == "__main__":
    main()
