"""The two prototype machines from the paper (Table 1 and Table 8)."""

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
    {
        "id": "snack-01", "name": "Snack and drink machine", "kind": "snack",
        "compartments": [
            {"code": "row-a", "name": "Coil row 1", "sensor": "ultrasonic", "unit": "items",
             "capacity": 10.0, "hopper_type": None, "position": 1},
            {"code": "row-b", "name": "Coil row 2", "sensor": "ultrasonic", "unit": "items",
             "capacity": 10.0, "hopper_type": None, "position": 2},
            {"code": "row-c", "name": "Coil row 3", "sensor": "ultrasonic", "unit": "items",
             "capacity": 10.0, "hopper_type": None, "position": 3},
        ],
    },
]
