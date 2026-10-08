"""Feature extraction and matching on top of OpenCV.

Why OpenCV rather than a hand-written descriptor: an in-repo SIFT-lite was
built and measured first (see docs/research/technology-decisions.md). It could
not separate correct from incorrect correspondences reliably (true-partner
rank-0 of 0%), because reproducing Lowe's normalisation and orientation
assignment well enough is a research-scale problem. OpenCV ships a maintained
SIFT implementation plus MAGSAC++ and calibrated-view geometry, all under the
Apache-2.0 licence, and it runs headless on CPU.

This module is a thin, testable wrapper so the rest of the pipeline does not
depend on OpenCV call signatures directly.
"""

from __future__ import annotations

from dataclasses import dataclass
from typing import Optional

import cv2
import numpy as np


@dataclass(frozen=True)
class FeatureSet:
    """Detected keypoints and their descriptors for one image."""

    image_name: str
    keypoints: np.ndarray          # (N, 2) float32 pixel coordinates
    sizes: np.ndarray             # (N,) float32 detection scale
    angles: np.ndarray            # (N,) float32 dominant orientation (degrees)
    descriptors: np.ndarray       # (N, 128) float32, L2-normalised

    def __len__(self) -> int:
        return len(self.keypoints)


def _sift(nfeatures: int, contrast_threshold: float) -> "cv2.SIFT":
    """Create a SIFT extractor that works across OpenCV 4.x and 5.x.

    OpenCV moved the SIFT implementation from contrib to the main `features2d`
    module; constructing `cv2.SIFT_create` works on both.
    """
    return cv2.SIFT_create(nfeatures=nfeatures,
                           contrastThreshold=contrast_threshold)


def detect_and_describe(image: np.ndarray, image_name: str,
                        nfeatures: int = 4000,
                        contrast_threshold: float = 0.01,
                        edge_threshold: float = 10.0) -> FeatureSet:
    """Detect SIFT keypoints and compute descriptors for a grayscale image."""
    if image.ndim == 3:
        image = cv2.cvtColor(image, cv2.COLOR_BGR2GRAY)
    sift = _sift(nfeatures, contrast_threshold)
    sift.setEdgeThreshold(edge_threshold)
    kps, desc = sift.detectAndCompute(image, None)
    if not kps:
        return FeatureSet(image_name, np.zeros((0, 2), np.float32),
                          np.zeros((0,), np.float32), np.zeros((0,), np.float32),
                          np.zeros((0, 128), np.float32))
    pts = np.array([k.pt for k in kps], dtype=np.float32)
    sizes = np.array([k.size for k in kps], dtype=np.float32)
    angles = np.array([k.angle for k in kps], dtype=np.float32)
    if desc is None:
        desc = np.zeros((len(kps), 128), dtype=np.float32)
    return FeatureSet(image_name, pts, sizes, angles, desc.astype(np.float32))


def match(feat_a: FeatureSet, feat_b: FeatureSet, ratio: float = 0.8,
          cross_check: bool = True) -> tuple[np.ndarray, np.ndarray, np.ndarray]:
    """Lowe-ratio match between two feature sets.

    Returns (idx_a, idx_b, distance) aligned arrays.
    """
    if len(feat_a) < 2 or len(feat_b) < 2:
        e = np.zeros(0, dtype=np.float32)
        i = np.zeros(0, dtype=np.int64)
        return i, i.copy(), e

    bf = cv2.BFMatcher(cv2.NORM_L2)
    knn = bf.knnMatch(feat_a.descriptors, feat_b.descriptors, k=2)

    a_idx: list[int] = []
    b_idx: list[int] = []
    dist: list[float] = []
    for pair in knn:
        if len(pair) < 2:
            continue
        m, n = pair[0], pair[1]
        # The ratio test rejects matches whose first alternative is nearly as
        # good as the best one; these are dominated by repetitive texture.
        if m.distance < ratio * n.distance:
            a_idx.append(m.queryIdx)
            b_idx.append(m.trainIdx)
            dist.append(float(m.distance))

    if cross_check and a_idx:
        # Symmetric check: the reverse match must point back at the same pair.
        # `bf.knnMatch` may return fewer rows than there are train features
        # (an unmatched descriptor yields no row), so index defensively and
        # pair by the train index rather than by row position.
        rev = bf.knnMatch(feat_b.descriptors, feat_a.descriptors, k=1)
        back: dict[int, int] = {}
        for pair in rev:
            if pair:
                back[int(pair[0].queryIdx)] = int(pair[0].trainIdx)
        keep = [k for k in range(len(a_idx))
                if back.get(int(b_idx[k]), -1) == int(a_idx[k])]
        a_idx = [a_idx[k] for k in keep]
        b_idx = [b_idx[k] for k in keep]
        dist = [dist[k] for k in keep]

    return (np.array(a_idx, dtype=np.int64), np.array(b_idx, dtype=np.int64),
            np.array(dist, dtype=np.float32))