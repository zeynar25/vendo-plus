"""The prototype machine from the paper (Table 1 and Table 8).

The study covers the coffee machine only. An earlier version also seeded a snack and
drink machine (snack-01); `python -m app.cli remove-machine snack-01 --yes` deletes it
from a database that still holds it.
"""

MACHINES = [
    {
        "id": "coffee-01", "name": "Coffee machine", "kind": "coffee",
        "compartments": [
            {"code": "coffee", "name": "Coffee hopper", "sensor": "load_cell", "unit": "g",
             "capacity": 1000.0, "hopper_type": "coffee", "position": 1},
            {"code": "milk", "name": "Milk hopper", "sensor": "load_cell", "unit": "g",
             "capacity": 1000.0, "hopper_type": "milk", "position": 2},
            {"code": "chocolate", "name": "Chocolate hopper", "sensor": "load_cell", "unit": "g",
             "capacity": 1000.0, "hopper_type": "chocolate", "position": 3},
        ],
    },
]
