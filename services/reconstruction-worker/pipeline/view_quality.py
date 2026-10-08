"""Which of your photos did the reconstruction actually use, and why not.

The worker already knows: which views PnP could not place, how many 3-D tracks
observe each one, how far its keypoints reproject, and how well it matched any
other photo at all. None of that reached the user, who only ever saw the final
"4 of 12 photos were not registered" line. This module turns that evidence into
one named verdict per photo.

What it deliberately does not do
--------------------------------
It does not invent a quality score. There is no single number here that ranks
photos, because the things that go wrong (blur, too little overlap, a photo of
nothing, a duplicate taken from the same spot) fail in different ways and no
metric catches them all. What it does is report the measured evidence and a
verdict derived from rules stated in the code below, so a user can see which
rule fired and disagree with it.

Every threshold is **relative to this capture** (a fraction of the median across
the views that did register), not an absolute constant, because an absolute
threshold means something different at 4000 keypoints per photo than at 300.
When there are too few registered views to form a median, the report says so
and falls back to registered/unregistered only, rather than pretending to a
comparison it cannot make.

A view is called:

  ``ok``         registered, and its evidence is not an outlier.
  ``weak``       registered, but its evidence is a clear outlier.
  ``unusable``   never registered. It contributed nothing to the model.
"""

from __future__ import annotations

from dataclasses import dataclass, field
from typing import Optional

import numpy as np

from .incremental import SfMResult, View

# A registered view is "weak" if it is this much below the capture's median on
# track support, or this much above it on reprojection error.
WEAK_TRACK_FRACTION = 0.5
WEAK_REPROJ_FACTOR = 2.0
# Below this many registered views a median is not meaningful, and the report
# falls back to registered/unregistered only.
MIN_VIEWS_FOR_RELATIVE = 3

VERDICT_OK = "ok"
VERDICT_WEAK = "weak"
VERDICT_UNUSABLE = "unusable"

# Human-readable explanations, keyed by the signal that produced them. The
# capture screen shows these verbatim, so they are phrased for a person who has
# just walked round an object with a phone.
NOTE_NO_EDGE = ("matched no other photo well enough to verify a pair, so it "
                "never entered the reconstruction")
NOTE_UNPLACED = ("matched other photos well ({inliers} verified features on "
                 "its best pair) but the solver could not place it, so the "
                 "surface only it saw is missing from the model")
NOTE_FEW_TRACKS = ("only {tracks} of the model's 3-D points are seen in this "
                   "photo, against a median of {median_tracks} in the others")
NOTE_HIGH_REPROJ = ("its keypoints sit {reproj:.2f} px from where the solved "
                    "camera predicts, against a median of {median_reproj:.2f} px")
NOTE_FEW_KEYPOINTS = ("only {keypoints} distinctive features were found, which "
                      "usually means blur, motion or flat lighting")
NOTE_NO_OBSERVATIONS = ("it was placed in the model but no reconstructed 3-D "
                        "point ended up observed in it")


@dataclass
class ViewReport:
    """One photo's measured evidence and the verdict drawn from it."""

    index: int
    image_name: str
    registered: bool
    role: str                       # "seed" | "pnp" | "unregistered"
    keypoints: int
    best_edge_inliers: Optional[int]
    best_edge_ratio: Optional[float]
    tracks_observed: int
    median_track_length: float
    mean_reprojection_error_px: Optional[float]
    verdict: str
    notes: list[str] = field(default_factory=list)

    def to_dict(self) -> dict:
        return {
            "index": self.index,
            "image_name": self.image_name,
            "registered": self.registered,
            "role": self.role,
            "keypoints": self.keypoints,
            "best_edge_inliers": self.best_edge_inliers,
            "best_edge_ratio": (round(self.best_edge_ratio, 4)
                                if self.best_edge_ratio is not None else None),
            "tracks_observed": self.tracks_observed,
            "median_track_length": round(self.median_track_length, 2),
            "mean_reprojection_error_px": (
                round(self.mean_reprojection_error_px, 4)
                if self.mean_reprojection_error_px is not None else None),
            "verdict": self.verdict,
            "notes": list(self.notes),
        }


@dataclass
class ViewQualityReport:
    views: list[ViewReport]
    relative: bool          # whether enough views registered to compare
    median_tracks: float
    median_reproj: float

    def to_dict(self) -> dict:
        ok = sum(1 for v in self.views if v.verdict == VERDICT_OK)
        weak = sum(1 for v in self.views if v.verdict == VERDICT_WEAK)
        unusable = sum(1 for v in self.views if v.verdict == VERDICT_UNUSABLE)
        flagged = [v for v in self.views if v.verdict != VERDICT_OK]
        if not flagged:
            note = (f"All {len(self.views)} photos contributed to the model. "
                    "Any problem here is geometric, not photographic.")
        else:
            names = ", ".join(v.image_name for v in flagged[:4])
            more = f", and {len(flagged) - 4} more" if len(flagged) > 4 else ""
            note = (f"{unusable} of {len(self.views)} photos were not used and "
                    f"{weak} contributed little: {names}{more}.")
        if not self.relative:
            note += (" Only some photos registered, so the ones that did are "
                     "reported without comparing them to each other.")
        return {
            "views": [v.to_dict() for v in self.views],
            "counts": {"ok": ok, "weak": weak, "unusable": unusable,
                       "total": len(self.views)},
            "compared_views": len(self.views) - unusable,
            "relative_thresholds_used": self.relative,
            "median_tracks_observed": round(self.median_tracks, 2),
            "median_reprojection_error_px": round(self.median_reproj, 4),
            "flagged": [v.index for v in flagged],
            "note": note,
        }


def _view_evidence(res: SfMResult, view: View) -> tuple[int, float, Optional[float]]:
    """(tracks observed, median track length, mean reprojection error)."""
    lengths: list[int] = []
    errs: list[float] = []
    for tr in res.tracks:
        if tr.xyz is None or view.index not in tr.obs:
            continue
        lengths.append(len(tr.obs))
        k = tr.obs[view.index]
        x = np.asarray(view.keypoints[k], dtype=np.float64)
        proj, _ = view.project(np.asarray(tr.xyz, dtype=np.float64).reshape(1, 3))
        if proj.shape[0] == 1 and np.all(np.isfinite(proj[0])):
            errs.append(float(np.linalg.norm(proj[0] - x)))
    med_len = float(np.median(lengths)) if lengths else 0.0
    med_err = float(np.mean(errs)) if errs else None
    return len(lengths), med_len, med_err


def build_report(res: SfMResult, views: Optional[list[View]] = None
                 ) -> ViewQualityReport:
    """One `ViewReport` per submitted photo, in submission order."""
    vs = views if views is not None else res.views
    registered = set(res.registered_indices)
    seeds = set(res.seed_indices) if res.seed_indices else (
        {res.gauge_index} if res.gauge_index is not None else set())

    evidence = {v.index: _view_evidence(res, v) for v in vs}
    reg = [v for v in vs if v.index in registered]
    med_tracks = float(np.median([evidence[v.index][0] for v in reg])) if reg else 0.0
    reg_errs = [evidence[v.index][2] for v in reg
                if evidence[v.index][2] is not None]
    med_reproj = float(np.median(reg_errs)) if reg_errs else float("nan")
    # A median needs a population to mean anything. With one or two registered
    # views, "half the median" is not a comparison.
    relative = len(reg) >= MIN_VIEWS_FOR_RELATIVE

    reports: list[ViewReport] = []
    for v in vs:
        n_tracks, med_len, mean_err = evidence[v.index]
        edge_in = res.best_edge_inliers.get(v.index)
        edge_ratio = res.best_edge_ratio.get(v.index)
        notes: list[str] = []

        if v.index not in registered:
            verdict = VERDICT_UNUSABLE
            role = "unregistered"
            if edge_in is None:
                notes.append(NOTE_NO_EDGE)
            elif edge_in > 0:
                # The common case, and the one worth naming. This photo is not
                # blurry and not untextured: it matched its neighbours, and the
                # solver still could not place it. Saying "not used" with no
                # reason would be true and useless.
                notes.append(NOTE_UNPLACED.format(inliers=edge_in))
        else:
            role = "seed" if v.index in seeds else "pnp"
            verdict = VERDICT_OK
            weak = False
            if relative:
                if med_tracks > 0 and n_tracks < WEAK_TRACK_FRACTION * med_tracks:
                    weak = True
                    notes.append(NOTE_FEW_TRACKS.format(
                        tracks=n_tracks, median_tracks=round(med_tracks, 1)))
                if (mean_err is not None and np.isfinite(med_reproj)
                        and med_reproj > 0
                        and mean_err > WEAK_REPROJ_FACTOR * med_reproj):
                    weak = True
                    notes.append(NOTE_HIGH_REPROJ.format(
                        reproj=mean_err, median_reproj=med_reproj))
            if n_tracks == 0:
                weak = True
                notes.append(NOTE_NO_OBSERVATIONS)
            verdict = VERDICT_WEAK if weak else VERDICT_OK

        # Keypoint count is reported for every view, but only turned into a
        # note when the view is otherwise fine: on a weak view the tracking
        # numbers already explain it better than a feature count would.
        if len(v.keypoints) < 50 and not notes:
            notes.append(NOTE_FEW_KEYPOINTS.format(keypoints=len(v.keypoints)))

        reports.append(ViewReport(
            index=v.index,
            image_name=v.image_name,
            registered=v.index in registered,
            role=role,
            keypoints=int(len(v.keypoints)),
            best_edge_inliers=(int(edge_in) if edge_in is not None else None),
            best_edge_ratio=edge_ratio,
            tracks_observed=int(n_tracks),
            median_track_length=med_len,
            mean_reprojection_error_px=mean_err,
            verdict=verdict,
            notes=notes,
        ))

    return ViewQualityReport(
        views=reports,
        relative=relative,
        median_tracks=med_tracks,
        median_reproj=med_reproj,
    )
