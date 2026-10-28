/**
 * BRIANE — Theme-aware Chart.js layer
 * Recolors chart ticks, grids, legends and axis titles whenever the
 * weather background switches between light (sunny/cloudy) and dark
 * (night/rainy/stormy) contexts. Loaded after Chart.js on every page
 * that renders charts.
 */

(function () {
    'use strict';

    var TICK_LIGHT = '#475569';                 // slate-600
    var GRID_LIGHT = 'rgba(15, 23, 42, 0.06)';
    var TICK_DARK = '#cbd5e1';                  // slate-300
    var GRID_DARK = 'rgba(255, 255, 255, 0.10)';

    function isDarkTheme() {
        return document.body.getAttribute('data-theme') === 'dark';
    }

    function applyChartTheme() {
        if (!window.Chart) return;

        var dark = isDarkTheme();
        var tick = dark ? TICK_DARK : TICK_LIGHT;
        var grid = dark ? GRID_DARK : GRID_LIGHT;

        // New charts created after this point inherit the right palette.
        Chart.defaults.color = tick;
        Chart.defaults.borderColor = grid;

        // Live-update every chart already on the page.
        var instances = Chart.instances || {};
        Object.keys(instances).forEach(function (id) {
            var chart = instances[id];
            if (!chart || !chart.options) return;

            var scales = chart.options.scales;
            if (scales) {
                Object.keys(scales).forEach(function (key) {
                    var scale = scales[key];
                    if (!scale) return;
                    if (scale.ticks) scale.ticks.color = tick;
                    if (scale.grid && scale.grid.drawOnChartArea !== false) scale.grid.color = grid;
                    if (scale.border) scale.border.color = grid;
                    // Only recolor titles — never flip visibility of axes
                    // the chart author deliberately left hidden.
                    if (scale.title && scale.title.display) scale.title.color = tick;
                });
            }

            var legendLabels = chart.options.plugins &&
                chart.options.plugins.legend &&
                chart.options.plugins.legend.labels;
            if (legendLabels) legendLabels.color = dark ? '#e2e8f0' : '#334155';

            chart.update('none');
        });
    }

    // Re-apply whenever the weather background (and therefore theme) changes.
    document.addEventListener('weatherBackgroundChanged', applyChartTheme);

    // Initial pass: once on load (covers charts created during init),
    // plus a short delay for charts constructed lazily after data arrives.
    if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', applyChartTheme);
    } else {
        applyChartTheme();
    }
    window.addEventListener('load', function () {
        applyChartTheme();
        setTimeout(applyChartTheme, 900);
    });

    // Exposed for manual re-apply after dynamically creating a chart.
    window.applyChartTheme = applyChartTheme;
})();
