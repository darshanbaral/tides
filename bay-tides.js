"use strict";
const $ = (id) => document.getElementById(id),
  DAY = 86400000,
  STEP = 360000,
  PACIFIC = "Etc/GMT+8";
const SOURCES = [
  {
    key: "palo",
    id: "9414525",
    name: "Palo Alto Yacht Harbor",
    color: "#16867c",
  },
  {
    key: "coyote",
    id: "9414575",
    name: "Coyote Creek",
    color: "#1976bd",
  },
  {
    key: "redwood",
    id: "9414523",
    name: "Redwood City",
    color: "#c45e30",
  },
  { key: "sf", id: "9414290", name: "San Francisco", color: "#815ac1" },
];
let loaded = null,
  datasets = {},
  busy = false,
  zoom = [0, 100];
const chart = echarts.init($("chart"), null, { renderer: "canvas" });
const number = (v) =>
  v !== null &&
  v !== undefined &&
  String(v).trim() !== "" &&
  Number.isFinite(Number(v))
    ? Number(v)
    : null;
const parseTime = (t) => Date.parse(t.replace(" ", "T") + "Z");
function dateInZone(t = Date.now(), tz = PACIFIC) {
  const p = new Intl.DateTimeFormat("en-US", {
    timeZone: tz,
    year: "numeric",
    month: "2-digit",
    day: "2-digit",
  }).formatToParts(t);
  return ["year", "month", "day"]
    .map((k) => p.find((x) => x.type === k).value)
    .join("-");
}
function addDays(s, n) {
  return new Date(Date.parse(s + "T12:00:00Z") + n * DAY)
    .toISOString()
    .slice(0, 10);
}
function pacificMidnight(s) {
  return Date.parse(s + "T00:00:00-08:00");
}
function selectedRange() {
  const start = $("start").value,
    end = $("end").value;
  if (!/^\d{4}-\d{2}-\d{2}$/.test(start) || !/^\d{4}-\d{2}-\d{2}$/.test(end))
    throw Error("Choose valid start and end dates.");
  const days = Math.round((Date.parse(end) - Date.parse(start)) / DAY) + 1;
  if (days < 1 || days > 31)
    throw Error(
      "Choose a range of 1–31 calendar days, with the end on or after the start.",
    );
  return {
    start,
    end,
    min: pacificMidnight(start),
    max: pacificMidnight(addDays(end, 1)),
  };
}
function fmt(t, opts = {}) {
  return new Intl.DateTimeFormat("en-US", {
    timeZone: PACIFIC,
    month: "short",
    day: "numeric",
    hour: "numeric",
    minute: "2-digit",
    timeZoneName: "short",
    ...opts,
  })
    .format(t)
    .replace("GMT-8", "PST");
}
function height(v, signed = false) {
  if (v === null || v === undefined || !Number.isFinite(v)) return "—";
  const x = v;
  return (signed && x > 0 ? "+" : "") + x.toFixed(2);
}
function unit() {
  return "ft";
}
function apiDate(t) {
  return new Date(t)
    .toISOString()
    .slice(0, 16)
    .replace(/-/g, "")
    .replace("T", " ");
}
async function request(station, product, begin, end, interval) {
  if (product === "water_level" && end - begin > 30 * DAY) {
    const cut = begin + 30 * DAY - STEP;
    const parts = await Promise.all([
      request(station, product, begin, cut, interval),
      request(station, product, cut + STEP, end, interval),
    ]);
    return { data: parts.flatMap((p) => p.data || []) };
  }
  const params = new URLSearchParams({
    application: "BayTidesStandalone",
    station,
    product,
    begin_date: apiDate(begin),
    end_date: apiDate(end),
    datum: "MLLW",
    units: "english",
    time_zone: "gmt",
    format: "json",
  });
  if (interval) params.set("interval", interval);
  const controller = new AbortController(),
    timer = setTimeout(() => controller.abort(), 30000);
  try {
    const response = await fetch(
      "https://api.tidesandcurrents.noaa.gov/api/prod/datagetter?" + params,
      { signal: controller.signal, cache: "no-store" },
    );
    if (!response.ok) throw Error("NOAA HTTP " + response.status);
    const json = await response.json();
    if (json.error) throw Error(json.error.message || "NOAA returned an error");
    return json;
  } catch (e) {
    if (e.name === "AbortError")
      throw Error("NOAA request timed out (30 seconds). Try Refresh data.");
    throw e;
  } finally {
    clearTimeout(timer);
  }
}
function points(rows) {
  return rows
    .map((r) => ({
      t: parseTime(r.t),
      v: number(r.v),
      type: r.type,
      q: r.q || "",
      f: r.f || "",
    }))
    .filter((p) => Number.isFinite(p.t))
    .sort((a, b) => a.t - b.t);
}
function joinDelta(observed, predicted, min, max) {
  const predictions = new Map(predicted.map((p) => [p.t, p.v]));
  return observed
    .filter((p) => p.t >= min && p.t < max)
    .map((p) => {
      const pv = predictions.get(p.t);
      return {
        ...p,
        observed: p.v,
        predicted: pv ?? null,
        v: p.v !== null && pv !== null && pv !== undefined ? p.v - pv : null,
      };
    });
}
function gapData(rows) {
  const out = [];
  for (const p of rows) {
    if (out.length && p.t - out[out.length - 1][0] > STEP * 1.5)
      out.push([p.t - STEP, null]);
    out.push([p.t, p.v === null ? null : p.v]);
  }
  return out;
}
function interpolate(rows, min, max) {
  const result = [];
  for (let i = 1; i < rows.length; i++) {
    const a = rows[i - 1],
      b = rows[i];
    if (a.v === null || b.v === null || b.t - a.t > 14 * 3600000) continue;
    const times = [a.t];
    for (let t = Math.ceil(a.t / STEP) * STEP; t < b.t; t += STEP)
      if (t > a.t) times.push(t);
    times.push(b.t);
    for (const t of times) {
      if (t < min || t >= max) continue;
      const v =
        a.v +
        ((b.v - a.v) * (1 - Math.cos((Math.PI * (t - a.t)) / (b.t - a.t)))) / 2;
      if (result.at(-1)?.t !== t) result.push({ t, v });
    }
  }
  return result;
}
async function load(reset = false) {
  if (busy) return;
  let range;
  try {
    range = reset ? selectedRange() : loaded || selectedRange();
  } catch (e) {
    $("notice").textContent = e.message;
    return;
  }
  busy = true;
  loaded = range;
  if (reset) zoom = [0, 100];
  $("notice").textContent = "";
  $("status").textContent = "Fetching 6 NOAA products…";
  for (const id of ["apply", "refresh", "csv", "start", "end"])
    $(id).disabled = true;
  document.querySelectorAll("[data-days]").forEach((b) => (b.disabled = true));
  $("chart").setAttribute("aria-busy", "true");
  const now = Date.now();
  const results = await Promise.allSettled(
    SOURCES.map(async (s) => {
      if (s.key === "palo") {
        const j = await request(
          s.id,
          "predictions",
          range.min - DAY,
          range.max + DAY,
          "hilo",
        );
        const raw = points(j.predictions || []);
        return {
          raw,
          rows: interpolate(raw, range.min, range.max),
          message: "NOAA high/low points + approximate curve",
        };
      }
      if (s.key === "coyote") {
        const j = await request(
          s.id,
          "predictions",
          range.min,
          range.max - 1,
          "6",
        );
        const rows = points(j.predictions || []).filter(
          (p) => p.t >= range.min && p.t < range.max,
        );
        return { raw: rows, rows, message: "6-minute NOAA predictions" };
      }
      const end = Math.min(range.max - 1, now);
      if (end < range.min)
        return {
          raw: [],
          rows: [],
          message: "Future range — no observations yet",
        };
      const pair = await Promise.allSettled([
        request(s.id, "water_level", range.min, end),
        request(s.id, "predictions", range.min, end, "6"),
      ]);
      const errors = pair.flatMap((r, i) =>
        r.status === "rejected"
          ? [(i === 0 ? "Observations: " : "Predictions: ") + r.reason.message]
          : [],
      );
      if (errors.length) throw Error(errors.join(" · "));
      const rows = joinDelta(
        points(pair[0].value.data || []),
        points(pair[1].value.predictions || []),
        range.min,
        range.max,
      );
      return {
        raw: rows,
        rows,
        message: "6-minute observed − predicted, exact timestamp matches",
      };
    }),
  );
  datasets = {};
  let ok = 0;
  results.forEach((r, i) => {
    const key = SOURCES[i].key;
    if (r.status === "fulfilled") {
      datasets[key] = r.value;
      if (r.value.rows.some((p) => p.v !== null)) ok++;
    } else
      datasets[key] = {
        rows: [],
        raw: [],
        error: r.reason.message || String(r.reason),
      };
  });
  busy = false;
  for (const id of ["apply", "refresh", "csv", "start", "end"])
    $(id).disabled = false;
  document.querySelectorAll("[data-days]").forEach((b) => (b.disabled = false));
  $("chart").setAttribute("aria-busy", "false");
  $("status").textContent =
    ok +
    "/4 series available · fetched " +
    fmt(Date.now(), { month: undefined, day: undefined });
  const problems = SOURCES.filter((s) => datasets[s.key].error);
  $("notice").textContent = problems.length
    ? problems.map((s) => s.name + ": " + datasets[s.key].error).join(" | ")
    : ok === 0
      ? "NOAA returned no usable data for this range. Try another date range."
      : "";
  render();
  renderSources();
}
function renderSources() {
  $("datasets").replaceChildren();
  for (const s of SOURCES) {
    const d = datasets[s.key];
    const row = document.createElement("div");
    row.className = "dataset";
    const a = document.createElement("a");
    a.href =
      "https://tidesandcurrents.noaa.gov/" +
      (s.key === "palo" || s.key === "coyote"
        ? "noaatidepredictions.html"
        : "waterlevels.html") +
      "?id=" +
      s.id;
    a.target = "_blank";
    a.rel = "noopener";
    a.textContent = s.name + " · " + s.id + " ↗";
    row.append(a);
    const info = document.createElement("span");
    info.textContent = d
      ? d.error
        ? "Unavailable: " + d.error
        : d.message +
          " · " +
          d.raw
            .filter(
              (p) => p.t >= loaded.min && p.t < loaded.max && p.v !== null,
            )
            .length.toLocaleString() +
          " points"
      : "Not loaded";
    row.append(info);
    $("datasets").append(row);
  }
}
function updateCards() {
  for (const [key, prefix] of [
    ["redwood", "redwood"],
    ["sf", "sf"],
  ]) {
    const p = datasets[key]?.rows.filter((p) => p.v !== null).at(-1);
    $(prefix + "-value").innerHTML = p
      ? height(p.v, true) + " <small>" + unit() + "</small>"
      : "—";
    $(prefix + "-time").textContent = p
      ? fmt(p.t) +
        " · " +
        (p.q === "p"
          ? "preliminary"
          : p.q === "v"
            ? "verified"
            : p.q || "quality unspecified") +
        (p.f && p.f.split(",").some((f) => f !== "0")
          ? " · NOAA flags " + p.f
          : "")
      : "No matched observations in loaded range";
  }
}
function tooltip(params) {
  if (!Array.isArray(params)) params = [params];
  const t = params[0]?.axisValue;
  if (!Number.isFinite(+t)) return "";
  let html = "<strong>" + fmt(+t) + "</strong>";
  for (const p of params) {
    if (!Array.isArray(p.value) || p.value[1] === null) continue;
    html +=
      "<br>" +
      p.marker +
      p.seriesName +
      ": <strong>" +
      Number(p.value[1]).toFixed(2) +
      " " +
      unit() +
      "</strong>";
    if (p.seriesId === "redwood" || p.seriesId === "sf") {
      const raw = datasets[p.seriesId]?.rows.find((r) => r.t === p.value[0]);
      if (raw) {
        html +=
          '<br><span style="color:#607a85">Observed ' +
          height(raw.observed) +
          " − predicted " +
          height(raw.predicted) +
          " " +
          unit() +
          " · " +
          (raw.q === "p"
            ? "preliminary"
            : raw.q === "v"
              ? "verified"
              : "quality unspecified") +
          (raw.f ? " · flags " + raw.f : "") +
          "</span>";
      }
    }
  }
  return html;
}
function render() {
  updateCards();
  if (!loaded) return;
  const checked = (k) =>
    document.querySelector('[data-series="' + k + '"]').checked;
  const now = Date.now();
  const nowLine =
    now >= loaded.min && now < loaded.max
      ? {
          symbol: "none",
          silent: true,
          label: { formatter: "Now", color: "#758b94" },
          lineStyle: { color: "#9bafb7", type: "dashed", width: 1 },
          data: [{ xAxis: now }],
        }
      : undefined;
  const tops = { palo: 11, coyote: 12 };
  for (const key of ["palo", "coyote"])
    tops[key] = Math.max(
      tops[key],
      Math.ceil(
        (datasets[key]?.rows || []).reduce(
          (max, p) => (p.v === null ? max : Math.max(max, p.v)),
          0,
        ) + 0.3,
      ),
    );
  const bands = (low, high, max) => ({
    silent: true,
    z: -1,
    label: {
      show: true,
      position: "insideTopRight",
      fontSize: 10,
      color: "#997644",
    },
    data: [
      [
        {
          name: low + "–" + high + " ft",
          yAxis: low,
          itemStyle: { color: "rgba(246,214,104,0.19)", borderWidth: 0 },
        },
        { yAxis: high },
      ],
      [
        {
          name: "Above " + high + " ft",
          yAxis: high,
          itemStyle: { color: "rgba(235,148,75,0.14)", borderWidth: 0 },
        },
        { yAxis: max },
      ],
    ],
  });
  const series = SOURCES.map((s, i) => ({
    id: s.key,
    name: {
      palo: "Palo Alto · approximate",
      coyote: "Coyote Creek · predicted",
      redwood: "Redwood City · Δ",
      sf: "San Francisco · Δ",
    }[s.key],
    type: "line",
    xAxisIndex: Math.min(i, 2),
    yAxisIndex: Math.min(i, 2),
    data: checked(s.key) ? gapData(datasets[s.key]?.rows || []) : [],
    showSymbol: false,
    symbolSize: 5,
    connectNulls: false,
    animation: false,
    lineStyle: {
      width: i < 2 ? 2 : 1.8,
      color: s.color,
      type: s.key === "palo" ? "dashed" : "solid",
    },
    itemStyle: { color: s.color },
    emphasis: { focus: "series" },
    ...(i < 2
      ? {
          markLine: nowLine,
          markArea: bands(i === 0 ? 9 : 10, i === 0 ? 10 : 11, tops[s.key]),
        }
      : {}),
    ...(i === 2
      ? {
          markLine: {
            symbol: "none",
            silent: true,
            label: { show: false },
            lineStyle: { color: "#97aeb7", width: 1, type: "solid" },
            data: [{ yAxis: 0 }],
          },
        }
      : {}),
  }));
  series.push({
    id: "highlow",
    name: "Palo Alto · NOAA high/low",
    type: "scatter",
    xAxisIndex: 0,
    yAxisIndex: 0,
    data: checked("palo")
      ? (datasets.palo?.raw || [])
          .filter((p) => p.t >= loaded.min && p.t < loaded.max && p.v !== null)
          .map((p) => [p.t, p.v])
      : [],
    symbolSize: 6,
    itemStyle: { color: "#16867c", borderColor: "#fff", borderWidth: 1 },
    z: 4,
  });
  const axis = {
    type: "time",
    min: loaded.min,
    max: loaded.max,
    axisLine: { lineStyle: { color: "#c7d9de" } },
    axisTick: { show: false },
    splitLine: { show: true, lineStyle: { color: "#eef3f4" } },
    axisLabel: {
      color: "#6b838e",
      fontSize: 10,
      hideOverlap: true,
      formatter: (t) =>
        new Intl.DateTimeFormat("en-US", {
          timeZone: PACIFIC,
          month: "short",
          day: "numeric",
          hour: "numeric",
          hourCycle: "h23",
        }).format(t),
    },
    axisPointer: { label: { formatter: (p) => fmt(p.value) } },
  };
  const title = (text, top, subtext) => ({
    text,
    left: 15,
    top,
    textStyle: { fontSize: 11, fontWeight: 650, color: "#607a85" },
    subtext,
    subtextStyle: { fontSize: 10, color: "#80949c" },
  });
  const tideY = (index, key) => ({
    type: "value",
    gridIndex: index,
    name: "ft MLLW",
    nameTextStyle: { fontSize: 10 },
    min: (v) => Math.min(0, Math.floor(v.min)),
    max: tops[key],
    axisLabel: { color: "#6b838e", fontSize: 10 },
    splitLine: { lineStyle: { color: "#e8eff1" } },
  });
  chart.setOption(
    {
      animation: false,
      textStyle: {
        fontFamily: "system-ui, sans-serif",
        color: "#123746",
      },
      title: [
        title(
          "PALO ALTO YACHT HARBOR · PREDICTED TIDE",
          18,
          "Yellow 9–10 ft · orange above 10 ft",
        ),
        title(
          "COYOTE CREEK · PREDICTED TIDE",
          365,
          "Yellow 10–11 ft · orange above 11 ft",
        ),
        title(
          "OBSERVED − PREDICTED  /  Δ",
          715,
          "Positive = higher than predicted · future values stay blank",
        ),
      ],
      tooltip: {
        trigger: "axis",
        confine: true,
        formatter: tooltip,
        axisPointer: { type: "cross" },
        textStyle: { fontSize: 12 },
        borderColor: "#dce7e9",
      },
      axisPointer: { link: [{ xAxisIndex: [0, 1, 2] }] },
      grid: [
        { left: 65, right: 22, top: 85, height: 230 },
        { left: 65, right: 22, top: 435, height: 230 },
        { left: 65, right: 22, top: 785, height: 130 },
      ],
      xAxis: [0, 1, 2].map((gridIndex) => ({ ...axis, gridIndex })),
      yAxis: [
        tideY(0, "palo"),
        tideY(1, "coyote"),
        {
          type: "value",
          gridIndex: 2,
          name: "Δ ft",
          nameTextStyle: { fontSize: 10 },
          min: (v) => Math.min(-0.1, v.min - 0.08),
          max: (v) => Math.max(0.1, v.max + 0.08),
          axisLabel: {
            color: "#6b838e",
            fontSize: 10,
            formatter: (v) => Number(v.toFixed(2)),
          },
          splitLine: { lineStyle: { color: "#e8eff1" } },
        },
      ],
      dataZoom: [
        {
          id: "inside",
          type: "inside",
          xAxisIndex: [0, 1, 2],
          start: zoom[0],
          end: zoom[1],
          filterMode: "none",
          zoomOnMouseWheel: true,
          moveOnMouseMove: $("mode").value === "pan",
        },
        {
          id: "slider",
          type: "slider",
          xAxisIndex: [0, 1, 2],
          start: zoom[0],
          end: zoom[1],
          bottom: 18,
          height: 28,
          filterMode: "none",
          borderColor: "#dce7e9",
          fillerColor: "#d2e7e680",
          handleStyle: { color: "#16867c" },
          textStyle: { fontSize: 10 },
          labelFormatter: (v) => fmt(v),
        },
      ],
      toolbox: {
        show: false,
        feature: {
          dataZoom: { xAxisIndex: [0, 1, 2], yAxisIndex: "none" },
        },
      },
      series,
    },
    true,
  );
  $("empty").style.display = SOURCES.some(
    (s) => checked(s.key) && datasets[s.key]?.rows.some((p) => p.v !== null),
  )
    ? "none"
    : "block";
  $("empty").textContent =
    "No visible data in this range. Check the date range, series toggles, or data source details.";
  if ($("mode").value === "box")
    chart.dispatchAction({
      type: "takeGlobalCursor",
      key: "dataZoomSelect",
      dataZoomSelectActive: true,
    });
  updateVisible();
}
function updateVisible() {
  if (!loaded) return;
  const span = loaded.max - loaded.min;
  $("visible-range").textContent =
    fmt(loaded.min + (span * zoom[0]) / 100) +
    " — " +
    fmt(loaded.min + (span * zoom[1]) / 100) +
    " · shared timeline";
}
chart.on("datazoom", (e) => {
  const b = e.batch?.[0] || e;
  if (b.start !== undefined) {
    zoom = [b.start, b.end];
  } else {
    const z = chart.getOption().dataZoom[0];
    zoom = [z.start, z.end];
  }
  updateVisible();
});
function setZoom(a, b) {
  const width = Math.min(100, Math.max(0.05, b - a));
  a = Math.max(0, Math.min(100 - width, a));
  zoom = [a, a + width];
  chart.dispatchAction({
    type: "dataZoom",
    start: zoom[0],
    end: zoom[1],
  });
  updateVisible();
}
function csv() {
  if (!loaded) return;
  const rows = [
    [
      "station_id",
      "station_name",
      "series",
      "timestamp_utc",
      "value_" + unit(),
      "observed_" + unit(),
      "predicted_" + unit(),
      "noaa_high_low",
      "noaa_quality",
      "noaa_flags",
    ],
  ];
  for (const s of SOURCES)
    for (const p of datasets[s.key]?.raw || []) {
      if (p.t < loaded.min || p.t >= loaded.max) continue;
      rows.push([
        s.id,
        s.name,
        s.key === "palo"
          ? "NOAA high/low prediction"
          : s.key === "coyote"
            ? "NOAA 6-minute prediction"
            : "observed minus predicted",
        new Date(p.t).toISOString(),
        p.v === null ? "" : height(p.v),
        p.observed == null ? "" : height(p.observed),
        p.predicted == null ? "" : height(p.predicted),
        p.type || "",
        p.q || "",
        p.f || "",
      ]);
    }
  const text = rows
    .map((r) =>
      r.map((v) => '"' + String(v).replaceAll('"', '""') + '"').join(","),
    )
    .join("\r\n");
  const url = URL.createObjectURL(
    new Blob([text], { type: "text/csv;charset=utf-8" }),
  );
  const a = document.createElement("a");
  a.href = url;
  a.download = "bay-tides_" + loaded.start + "_" + loaded.end + ".csv";
  a.click();
  setTimeout(() => URL.revokeObjectURL(url), 1000);
}
function preset(days) {
  const today = dateInZone();
  $("start").value = days === 1 || days === 31 ? today : addDays(today, -1);
  $("end").value = addDays($("start").value, days - 1);
  document
    .querySelectorAll("[data-days]")
    .forEach((b) => b.classList.toggle("active", +b.dataset.days === days));
  load(true);
}
function positionPopover(popup, button) {
  const rect = button.getBoundingClientRect(),
    gap = 8,
    margin = 14;
  const width = popup.offsetWidth,
    height = popup.offsetHeight;
  const left = Math.max(
    margin,
    Math.min(rect.left, window.innerWidth - width - margin),
  );
  let top = rect.bottom + gap;
  if (top + height > window.innerHeight - margin) top = rect.top - gap - height;
  top = Math.max(margin, Math.min(top, window.innerHeight - height - margin));
  popup.style.left = left + "px";
  popup.style.top = top + "px";
}
for (const [popupId, buttonId] of [
  ["palo-conversion-popup", "palo-conversion-button"],
  ["coyote-conversion-popup", "coyote-conversion-button"],
  ["impacts-popup", "impacts-button"],
]) {
  const popup = $(popupId),
    button = $(buttonId);
  popup.addEventListener("toggle", (event) => {
    if (event.newState === "open") positionPopover(popup, button);
  });
  window.addEventListener("resize", () => {
    if (popup.matches(":popover-open")) positionPopover(popup, button);
  });
  window.addEventListener(
    "scroll",
    () => {
      if (popup.matches(":popover-open")) popup.hidePopover();
    },
    { passive: true },
  );
}
$("apply").onclick = () => load(true);
$("refresh").onclick = () => load(false);
document
  .querySelectorAll("[data-days]")
  .forEach((b) => (b.onclick = () => preset(+b.dataset.days)));
for (const id of ["start", "end"])
  $(id).onchange = () =>
    document
      .querySelectorAll("[data-days]")
      .forEach((b) => b.classList.remove("active"));
$("mode").onchange = render;
document
  .querySelectorAll("[data-series]")
  .forEach((c) => (c.onchange = render));
$("reset").onclick = () => setZoom(0, 100);
$("zoom-in").onclick = () => {
  const w = (zoom[1] - zoom[0]) / 2,
    c = (zoom[0] + zoom[1]) / 2;
  setZoom(c - w / 2, c + w / 2);
};
$("zoom-out").onclick = () => {
  const w = Math.min(100, (zoom[1] - zoom[0]) * 2),
    c = (zoom[0] + zoom[1]) / 2;
  setZoom(c - w / 2, c + w / 2);
};
$("left").onclick = () => {
  const w = zoom[1] - zoom[0];
  setZoom(zoom[0] - w * 0.3, zoom[1] - w * 0.3);
};
$("right").onclick = () => {
  const w = zoom[1] - zoom[0];
  setZoom(zoom[0] + w * 0.3, zoom[1] + w * 0.3);
};
$("csv").onclick = csv;
new ResizeObserver(() => chart.resize()).observe($("chart"));
renderSources();
preset(7);
