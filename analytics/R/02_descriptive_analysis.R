# =====================================================================
# Step 2: descriptive analysis of the CLEANED data
# =====================================================================
suppressPackageStartupMessages({ library(dplyr); library(ggplot2) })
if (!exists("in_file")) {
  a <- commandArgs(trailingOnly = TRUE)
  out_dir <- if (length(a) >= 2) a[2] else "outputs"
}
df <- read.csv(file.path(out_dir, "cleaned_data.csv"), stringsAsFactors = FALSE)
df$collection_date <- as.Date(df$collection_date)
df$month <- as.integer(format(df$collection_date, "%m"))

# 1. Summary table of numeric variables
num_vars <- c("mortality_pct", "larval_density", "rainfall_mm", "temp_c", "ndvi",
              "elevation_m", "dist_water_km", "itn_use_pct", "slide_positivity_pct")
summary_tbl <- do.call(rbind, lapply(num_vars, function(v) {
  x <- df[[v]]
  data.frame(variable = v, n = sum(!is.na(x)), mean = mean(x), sd = sd(x),
             min = min(x), median = median(x), max = max(x))
}))
write.csv(summary_tbl, file.path(out_dir, "descriptive_summary.csv"), row.names = FALSE)

# 2. WHO resistance classes: <90% resistant; 90-<98% possible; >=98% susceptible
df$resistance_status <- cut(df$mortality_pct, breaks = c(-Inf, 90, 98, Inf),
                            labels = c("Resistant", "Possible resistance", "Susceptible"),
                            right = FALSE)
res_tbl <- df %>% group_by(state, insecticide) %>%
  summarise(n = n(), mean_mortality = round(mean(mortality_pct), 1),
            pct_resistant = round(100 * mean(resistance_status == "Resistant"), 1),
            .groups = "drop")
write.csv(res_tbl, file.path(out_dir, "resistance_by_state_insecticide.csv"), row.names = FALSE)

# 3. Species composition by state (%)
sp_tbl <- df %>% count(state, species) %>% group_by(state) %>%
  mutate(pct = round(100 * n / sum(n), 1)) %>% ungroup()
write.csv(sp_tbl, file.path(out_dir, "species_by_state.csv"), row.names = FALSE)

# 4. Figures
theme_set(theme_minimal(base_size = 11))
ggsave(file.path(out_dir, "fig_positivity_by_state.png"),
       ggplot(df, aes(state, slide_positivity_pct, fill = state)) + geom_boxplot(show.legend = FALSE) +
         labs(title = "Slide positivity by state", x = NULL, y = "Positivity (%)"),
       width = 6, height = 4, dpi = 150)
ggsave(file.path(out_dir, "fig_mortality_by_insecticide.png"),
       ggplot(df, aes(insecticide, mortality_pct, fill = insecticide)) + geom_boxplot(show.legend = FALSE) +
         geom_hline(yintercept = c(90, 98), linetype = "dashed") +
         labs(title = "Bioassay mortality (WHO thresholds dashed)", x = NULL, y = "Mortality (%)") +
         theme(axis.text.x = element_text(angle = 20, hjust = 1)),
       width = 7, height = 4, dpi = 150)
monthly <- df %>% group_by(month, region = ifelse(state == "Kano", "Kano", "Lagos/Osun")) %>%
  summarise(positivity = mean(slide_positivity_pct), .groups = "drop")
ggsave(file.path(out_dir, "fig_seasonality.png"),
       ggplot(monthly, aes(month, positivity, colour = region)) + geom_line(linewidth = 1) +
         scale_x_continuous(breaks = 1:12) +
         labs(title = "Seasonality of slide positivity", x = "Month", y = "Mean positivity (%)"),
       width = 7, height = 4, dpi = 150)
ggsave(file.path(out_dir, "fig_species_by_state.png"),
       ggplot(sp_tbl, aes(state, pct, fill = species)) + geom_col() +
         labs(title = "Species composition by state", x = NULL, y = "% of records"),
       width = 7, height = 4, dpi = 150)

cat("Descriptive tables and figures written to", out_dir, "\n")
