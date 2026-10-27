# =====================================================================
# VECDIM - shared helpers for the R analytics pipeline
#
# The validation rules in validate_records() are the REFERENCE the mobile
# app and API must reproduce (see docs/validation_rules.md).
# =====================================================================

# Reference date used for the "future date" rule, so results are reproducible.
# (The app should use the device/server clock; the parity test in the brief
# uses this fixed date.)
#
# VECDIM change (the only edit to the pack's R code): the backend sets VECDIM_REF_DATE to today's date
# on every run, so a live record dated tomorrow is flagged. Without it the original fixed date is used,
# which is what the parity test and the brief's reference numbers need.
REF_DATE <- if (nzchar(Sys.getenv("VECDIM_REF_DATE"))) as.Date(Sys.getenv("VECDIM_REF_DATE")) else as.Date("2026-10-08")

# Approximate bounding boxes (WGS84 decimal degrees) for the three pilot states
STATE_BOX <- data.frame(
  state   = c("Lagos", "Kano", "Osun"),
  lat_min = c(6.3, 11.5, 7.0),  lat_max = c(6.8, 12.6, 8.2),
  lon_min = c(2.7,  8.0, 4.0),  lon_max = c(4.4,  9.2, 5.0),
  stringsAsFactors = FALSE
)
NIGERIA_LAT <- c(4, 14)
NIGERIA_LON <- c(2.5, 15)

# Reference point (approximate centre) of each LGA, used to warn when a GPS
# point is far from the LGA the field worker selected. Same values as
# data/lga_reference.csv. A real deployment would use LGA boundary polygons.
LGA_REF <- data.frame(
  state = rep(c("Lagos", "Kano", "Osun"), each = 5),
  lga   = c("Ikorodu", "Alimosho", "Epe", "Badagry", "Eti-Osa",
            "Dala", "Nasarawa", "Gwale", "Tarauni", "Ungogo",
            "Osogbo", "Ife Central", "Ilesa East", "Iwo", "Ede North"),
  ref_lat = c(6.62, 6.60, 6.58, 6.43, 6.45,
              12.00, 12.00, 11.98, 11.97, 12.05,
              7.77, 7.48, 7.62, 7.63, 7.74),
  ref_lon = c(3.51, 3.25, 3.98, 2.88, 3.60,
              8.52, 8.55, 8.49, 8.54, 8.48,
              4.56, 4.56, 4.73, 4.18, 4.43),
  stringsAsFactors = FALSE
)
LGA_MAX_KM <- 25   # farther than this from the LGA reference point = flag

# Great-circle (haversine) distance in km, Earth radius 6371 km
haversine_km <- function(lat1, lon1, lat2, lon2) {
  rad <- pi / 180
  a <- sin((lat2 - lat1) * rad / 2)^2 +
       cos(lat1 * rad) * cos(lat2 * rad) * sin((lon2 - lon1) * rad / 2)^2
  2 * 6371 * asin(pmin(1, sqrt(a)))
}

RULES <- c("GPS_outside_nigeria", "GPS_zero_zero", "GPS_state_mismatch",
           "GPS_far_from_lga", "n_dead_gt_n_exposed", "positivity_out_range", "future_date",
           "temp_implausible", "rainfall_implausible", "duplicate", "missing_core")

na_false <- function(x) { x[is.na(x)] <- FALSE; x }

# Returns one row per record: record_id, one TRUE/FALSE column per rule, any_flag.
validate_records <- function(d, ref_date = REF_DATE) {
  idx <- match(d$state, STATE_BOX$state)
  lat_min <- STATE_BOX$lat_min[idx]; lat_max <- STATE_BOX$lat_max[idx]
  lon_min <- STATE_BOX$lon_min[idx]; lon_max <- STATE_BOX$lon_max[idx]

  # Distance from the selected LGA's reference point (unknown LGA = flagged)
  li <- match(paste(d$state, d$lga), paste(LGA_REF$state, LGA_REF$lga))
  dist_km <- haversine_km(d$latitude, d$longitude, LGA_REF$ref_lat[li], LGA_REF$ref_lon[li])

  # Duplicate key. The EARLIEST record_id in a duplicate group is kept;
  # later submissions with the same key are flagged.
  key <- paste(d$ward, d$collection_date, d$species, d$insecticide, d$n_exposed, d$n_dead)
  ord <- order(d$record_id)
  is_dup <- logical(nrow(d)); is_dup[ord] <- duplicated(key[ord])

  flags <- data.frame(
    record_id = d$record_id,
    GPS_outside_nigeria  = !(d$latitude  >= NIGERIA_LAT[1] & d$latitude  <= NIGERIA_LAT[2] &
                             d$longitude >= NIGERIA_LON[1] & d$longitude <= NIGERIA_LON[2]),
    GPS_zero_zero        = d$latitude == 0 & d$longitude == 0,
    # unknown state, or point outside that state's box
    GPS_state_mismatch   = is.na(idx) | !(d$latitude >= lat_min & d$latitude <= lat_max &
                                          d$longitude >= lon_min & d$longitude <= lon_max),
    # Warn: point is inside the chosen state but more than LGA_MAX_KM from the chosen LGA
    GPS_far_from_lga     = is.na(li) | dist_km > LGA_MAX_KM,
    n_dead_gt_n_exposed  = d$n_dead > d$n_exposed,
    positivity_out_range = d$slide_positivity_pct < 0 | d$slide_positivity_pct > 100,
    future_date          = d$collection_date > ref_date,
    temp_implausible     = d$temp_c < 10 | d$temp_c > 50,
    rainfall_implausible = d$rainfall_mm < 0 | d$rainfall_mm > 1500,
    duplicate            = is_dup,
    # completeness of core covariates / species
    missing_core         = is.na(d$ndvi) | is.na(d$rainfall_mm) | is.na(d$itn_use_pct) | is.na(d$species),
    stringsAsFactors = FALSE
  )
  for (r in RULES) flags[[r]] <- na_false(flags[[r]])
  flags$any_flag <- rowSums(flags[, RULES]) > 0
  flags
}

# AUC by the rank (Mann-Whitney) formula, no extra package needed
auc <- function(truth_01, score) {
  r <- rank(score); n1 <- sum(truth_01 == 1); n0 <- sum(truth_01 == 0)
  (sum(r[truth_01 == 1]) - n1 * (n1 + 1) / 2) / (n1 * n0)
}
