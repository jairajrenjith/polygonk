from __future__ import annotations

import math
import os
import threading
from collections import defaultdict
from typing import Any

import cv2
import numpy as np
from fastapi import FastAPI, File, Form, HTTPException, UploadFile
from fastapi.middleware.cors import CORSMiddleware
from ultralytics import YOLO


app = FastAPI(
    title="Polygonk CV Engine",
    version="1.1.0",
)


app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_credentials=False,
    allow_methods=["*"],
    allow_headers=["*"],
)


MODEL_NAME = os.getenv(
    "POLYGONK_MODEL",
    "yolo11m-seg.pt",
)


_model = None
_model_lock = threading.Lock()


_sessions: dict[str, dict[str, Any]] = defaultdict(
    lambda: {
        "next_id": 1,
        "objects": [],
        "class_numbers": defaultdict(int),
    }
)


def get_model():
    global _model

    if _model is None:
        with _model_lock:
            if _model is None:
                _model = YOLO(
                    MODEL_NAME
                )

    return _model


def contour_shape(
    contour: np.ndarray,
) -> tuple[str, float, float]:

    area = float(
        cv2.contourArea(contour)
    )

    perimeter = float(
        cv2.arcLength(
            contour,
            True,
        )
    )

    if area <= 1 or perimeter <= 0:
        return (
            "Unknown",
            0.0,
            perimeter,
        )

    approx = cv2.approxPolyDP(
        contour,
        0.025 * perimeter,
        True,
    )

    vertices = len(approx)

    circularity = float(
        4
        * math.pi
        * area
        / (perimeter * perimeter)
    )

    x, y, w, h = cv2.boundingRect(
        contour
    )

    aspect = (
        w / h
        if h
        else 0.0
    )

    extent = (
        area / (w * h)
        if w and h
        else 0.0
    )

    if (
        circularity > 0.84
        and 0.85 < aspect < 1.15
    ):
        return (
            "Circle",
            min(
                1.0,
                circularity,
            ),
            perimeter,
        )

    if vertices == 3:
        return (
            "Triangle",
            min(
                1.0,
                circularity + 0.15,
            ),
            perimeter,
        )

    if vertices == 4:
        rectangularity = (
            area / float(w * h)
            if w and h
            else 0.0
        )

        if (
            0.88 <= aspect <= 1.12
            and rectangularity > 0.82
        ):
            return (
                "Square",
                rectangularity,
                perimeter,
            )

        if rectangularity > 0.70:
            return (
                "Rectangle",
                rectangularity,
                perimeter,
            )

        return (
            "Quadrilateral",
            rectangularity,
            perimeter,
        )

    if vertices == 5:
        return (
            "Pentagon",
            min(
                1.0,
                extent + 0.1,
            ),
            perimeter,
        )

    if vertices == 6:
        return (
            "Hexagon",
            min(
                1.0,
                extent + 0.1,
            ),
            perimeter,
        )

    if vertices == 8:
        return (
            "Octagon",
            min(
                1.0,
                extent + 0.1,
            ),
            perimeter,
        )

    if circularity > 0.68:
        return (
            "Ellipse",
            circularity,
            perimeter,
        )

    return (
        "Polygon",
        min(1.0, extent),
        perimeter,
    )


def mask_geometry(
    mask: np.ndarray,
) -> tuple:

    binary = (
        (mask > 0.5)
        .astype(np.uint8)
        * 255
    )

    contours, _ = cv2.findContours(
        binary,
        cv2.RETR_EXTERNAL,
        cv2.CHAIN_APPROX_SIMPLE,
    )

    if not contours:
        return (
            "Unknown",
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
            0.0,
        )

    contour = max(
        contours,
        key=cv2.contourArea,
    )

    (
        shape,
        score,
        perimeter,
    ) = contour_shape(
        contour
    )

    area = float(
        cv2.contourArea(
            contour
        )
    )

    x, y, w, h = cv2.boundingRect(
        contour
    )

    return (
        shape,
        score,
        area,
        perimeter,
        float(x),
        float(y),
        float(w),
        float(h),
    )


def iou(
    a: tuple[
        float,
        float,
        float,
        float,
    ],
    b: tuple[
        float,
        float,
        float,
        float,
    ],
) -> float:

    ax, ay, aw, ah = a
    bx, by, bw, bh = b

    x1 = max(ax, bx)
    y1 = max(ay, by)

    x2 = min(
        ax + aw,
        bx + bw,
    )

    y2 = min(
        ay + ah,
        by + bh,
    )

    inter = (
        max(0.0, x2 - x1)
        * max(0.0, y2 - y1)
    )

    union = (
        aw * ah
        + bw * bh
        - inter
    )

    return (
        inter / union
        if union
        else 0.0
    )


def center_distance_score(
    a: tuple[
        float,
        float,
        float,
        float,
    ],
    b: tuple[
        float,
        float,
        float,
        float,
    ],
) -> float:

    ax, ay, aw, ah = a
    bx, by, bw, bh = b

    acx = ax + aw / 2
    acy = ay + ah / 2

    bcx = bx + bw / 2
    bcy = by + bh / 2

    distance = math.hypot(
        acx - bcx,
        acy - bcy,
    )

    diagonal = max(
        1.0,
        math.hypot(
            max(aw, bw),
            max(ah, bh),
        ),
    )

    return max(
        0.0,
        1.0
        - distance
        / (diagonal * 1.75),
    )


def size_score(
    a: tuple[
        float,
        float,
        float,
        float,
    ],
    b: tuple[
        float,
        float,
        float,
        float,
    ],
) -> float:

    old_area = max(
        1.0,
        a[2] * a[3],
    )

    new_area = max(
        1.0,
        b[2] * b[3],
    )

    return (
        min(
            old_area,
            new_area,
        )
        / max(
            old_area,
            new_area,
        )
    )


def match_or_create(
    session: dict[str, Any],
    candidate: dict[str, Any],
    used_track_ids: set[str],
) -> tuple[str, bool]:

    box = (
        candidate["px"],
        candidate["py"],
        candidate["pw"],
        candidate["ph"],
    )

    best = None
    best_score = 0.0

    for obj in session["objects"]:

        if (
            obj["track_id"]
            in used_track_ids
        ):
            continue

        if (
            obj["name"]
            != candidate["name"]
        ):
            continue

        old_box = (
            obj["px"],
            obj["py"],
            obj["pw"],
            obj["ph"],
        )

        overlap = iou(
            old_box,
            box,
        )

        center = (
            center_distance_score(
                old_box,
                box,
            )
        )

        size = size_score(
            old_box,
            box,
        )

        score = (
            overlap * 0.55
            + center * 0.30
            + size * 0.15
        )

        if (
            overlap >= 0.18
            or center >= 0.58
        ):
            if score > best_score:
                best_score = score
                best = obj

    if best is not None:

        best.update(
            candidate
        )

        best["observations"] = (
            int(
                best.get(
                    "observations",
                    0,
                )
            )
            + 1
        )

        used_track_ids.add(
            best["track_id"]
        )

        return (
            best["track_id"],
            False,
        )

    class_key = candidate["name"]

    session[
        "class_numbers"
    ][class_key] += 1

    class_number = session[
        "class_numbers"
    ][class_key]

    safe_name = (
        candidate["name"]
        .upper()
        .replace(" ", "_")
    )

    track_id = (
        f"{safe_name}_"
        f"{session['next_id']:03d}"
    )

    session["next_id"] += 1

    candidate[
        "track_id"
    ] = track_id

    candidate[
        "class_number"
    ] = class_number

    candidate[
        "observations"
    ] = 1

    session[
        "objects"
    ].append(candidate)

    used_track_ids.add(
        track_id
    )

    return (
        track_id,
        True,
    )


def public_object(
    obj: dict[str, Any],
) -> dict[str, Any]:

    return {
        "track_id":
            obj["track_id"],

        "name":
            obj["name"],

        "display_name":
            obj.get(
                "display_name",
                obj["name"],
            ),

        "shape":
            obj["shape"],

        "shape_score":
            obj["shape_score"],

        "area":
            obj["area"],

        "perimeter":
            obj["perimeter"],

        "x":
            obj["x"],

        "y":
            obj["y"],

        "w":
            obj["w"],

        "h":
            obj["h"],

        "confidence":
            obj["confidence"],

        "observations":
            obj["observations"],
    }


@app.get("/health")
def health():
    return {
        "ok": True,
        "model": MODEL_NAME,
    }


@app.post("/analyze")
async def analyze(
    image: UploadFile = File(...),
    session_id: str = Form(...),
):

    data = await image.read()

    if not data:
        raise HTTPException(
            400,
            "Empty image",
        )

    arr = np.frombuffer(
        data,
        dtype=np.uint8,
    )

    frame = cv2.imdecode(
        arr,
        cv2.IMREAD_COLOR,
    )

    if frame is None:
        raise HTTPException(
            400,
            "Invalid image",
        )

    height, width = (
        frame.shape[:2]
    )

    model = get_model()

    try:
        with _model_lock:
            result = model(
                frame,
                verbose=False,
            )[0]

    except Exception as exc:
        raise HTTPException(
            500,
            f"Model inference failed: {exc}",
        ) from exc

    names = result.names

    detections = []

    if (
        result.masks is not None
        and result.boxes is not None
    ):

        masks = (
            result.masks.data
            .cpu()
            .numpy()
        )

        boxes = (
            result.boxes.xyxy
            .cpu()
            .numpy()
        )

        classes = (
            result.boxes.cls
            .cpu()
            .numpy()
            .astype(int)
        )

        confs = (
            result.boxes.conf
            .cpu()
            .numpy()
        )

        for (
            mask,
            box,
            cls,
            conf,
        ) in zip(
            masks,
            boxes,
            classes,
            confs,
        ):

            confidence = float(
                conf
            )

            if confidence < 0.45:
                continue

            mask_full = cv2.resize(
                mask.astype(
                    np.float32
                ),
                (
                    width,
                    height,
                ),
                interpolation=cv2.INTER_NEAREST,
            )

            (
                shape,
                shape_score,
                area,
                perimeter,
                px,
                py,
                pw,
                ph,
            ) = mask_geometry(
                mask_full
            )

            if (
                area
                < max(
                    120.0,
                    width
                    * height
                    * 0.00008,
                )
            ):
                continue

            name = names[
                int(cls)
            ].replace(
                "cell phone",
                "Phone",
            )

            detections.append(
                {
                    "name":
                        name,

                    "shape":
                        shape,

                    "shape_score":
                        round(
                            float(
                                shape_score
                            ),
                            4,
                        ),

                    "area":
                        round(
                            area,
                            2,
                        ),

                    "perimeter":
                        round(
                            perimeter,
                            2,
                        ),

                    "x":
                        round(
                            px
                            / width
                            * 100,
                            3,
                        ),

                    "y":
                        round(
                            py
                            / height
                            * 100,
                            3,
                        ),

                    "w":
                        round(
                            pw
                            / width
                            * 100,
                            3,
                        ),

                    "h":
                        round(
                            ph
                            / height
                            * 100,
                            3,
                        ),

                    "px": px,
                    "py": py,
                    "pw": pw,
                    "ph": ph,

                    "confidence":
                        round(
                            confidence,
                            4,
                        ),
                }
            )

    filtered = []

    for detection in sorted(
        detections,
        key=lambda item:
            item["area"],
        reverse=True,
    ):

        duplicate = any(
            detection["name"]
            == existing["name"]
            and iou(
                (
                    detection["px"],
                    detection["py"],
                    detection["pw"],
                    detection["ph"],
                ),
                (
                    existing["px"],
                    existing["py"],
                    existing["pw"],
                    existing["ph"],
                ),
            )
            > 0.65
            for existing
            in filtered
        )

        if not duplicate:
            filtered.append(
                detection
            )

    session = _sessions[
        session_id
    ]

    used_track_ids = set()
    new_objects = []

    for detection in filtered:

        (
            track_id,
            is_new,
        ) = match_or_create(
            session,
            detection,
            used_track_ids,
        )

        obj = next(
            item
            for item
            in session[
                "objects"
            ]
            if item[
                "track_id"
            ]
            == track_id
        )

        display_name = (
            f"{obj['name']} "
            f"{obj['class_number']}"
        )

        obj[
            "display_name"
        ] = display_name

        detection[
            "track_id"
        ] = track_id

        detection[
            "class_number"
        ] = obj[
            "class_number"
        ]

        detection[
            "display_name"
        ] = display_name

        if is_new:
            new_objects.append(
                public_object(
                    obj
                )
            )

    current = []

    for detection in filtered:

        obj = next(
            item
            for item
            in session[
                "objects"
            ]
            if item[
                "track_id"
            ]
            == detection[
                "track_id"
            ]
        )

        current.append(
            public_object(
                obj
            )
        )

    return {
        "detections":
            current,
        "new_objects":
            new_objects,
    }