"use client";

import { useCallback, useEffect, useMemo, useState } from "react";
import dynamic from "next/dynamic";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

type JsonRecord = Record<string, unknown>;
type DataRow = Record<string, unknown>;
type ColumnKind = "time" | "number" | "boolean" | "text";
type ChartType = "line" | "bar" | "scatter";

type ColumnProfile = {
  key: string;
  label: string;
  kind: ColumnKind;
  nonEmptyCount: number;
  numericCount: number;
  timeCount: number;
};

type DataTable = {
  id: string;
  label: string;
  path: string;
  rows: DataRow[];
  columns: ColumnProfile[];
  sourceCount: number;
  combined: boolean;
};

type LoadMessage = {
  type: "success" | "error";
  text: string;
};

const INDEX_FIELD = "__index";
const SOURCE_FIELD = "__source";
const GROUP_PREFIX = "__group_";
const MAX_SERIES_COUNT = 64;
const basePath = process.env.NEXT_PUBLIC_BASE_PATH ?? "";

const chartTypes: Array<{ value: ChartType; label: string }> = [
  { value: "line", label: "折线图" },
  { value: "bar", label: "柱状图" },
  { value: "scatter", label: "散点图" },
];

const palette = ["#4f6fd9", "#75bd61", "#d49d37", "#d65f5f", "#4aa5a8", "#a56cc1", "#d17b9f", "#7b8a4d"];

const dateTimeFormatter = new Intl.DateTimeFormat("zh-CN", {
  year: "numeric",
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const shortDateFormatter = new Intl.DateTimeFormat("zh-CN", {
  month: "2-digit",
  day: "2-digit",
  hour: "2-digit",
  minute: "2-digit",
});

const numberFormatter = new Intl.NumberFormat("zh-CN", {
  maximumFractionDigits: 2,
});

const isRecord = (value: unknown): value is JsonRecord =>
  typeof value === "object" && value !== null && !Array.isArray(value);

const isGeneratedField = (key: string) =>
  key === INDEX_FIELD || key === SOURCE_FIELD || key.startsWith(GROUP_PREFIX);

const getColumnLabel = (key: string) => {
  if (key === INDEX_FIELD) return "序号";
  if (key === SOURCE_FIELD) return "数据来源";
  if (key.startsWith(GROUP_PREFIX)) return `路径 ${key.slice(GROUP_PREFIX.length)}`;
  return key;
};

const toPathLabel = (segments: string[]) => (segments.length ? segments.join(" / ") : "根数据");

const stringifyValue = (value: unknown) => {
  if (value === null || value === undefined) return "";
  if (typeof value === "string") return value;
  if (typeof value === "number" || typeof value === "boolean") return String(value);

  try {
    return JSON.stringify(value);
  } catch {
    return String(value);
  }
};

const parseNumber = (value: unknown) => {
  if (typeof value === "number" && Number.isFinite(value)) return value;
  if (typeof value !== "string") return null;

  const trimmed = value.trim();
  if (!trimmed) return null;

  const normalized = Number(trimmed.replace(/,/g, ""));
  return Number.isFinite(normalized) ? normalized : null;
};

const looksLikeTimeField = (key: string) => {
  const normalized = key.toLowerCase();
  return (
    normalized.includes("time") ||
    normalized.includes("date") ||
    normalized.endsWith("_at") ||
    normalized === "ts" ||
    normalized === "timestamp"
  );
};

const looksLikeDateString = (value: string) =>
  /^\d{4}[-/]\d{1,2}[-/]\d{1,2}/.test(value.trim()) ||
  /^\d{1,2}[-/]\d{1,2}[-/]\d{2,4}/.test(value.trim());

const parseTime = (value: unknown, key: string) => {
  if (value instanceof Date && Number.isFinite(value.getTime())) return value.getTime();

  if (typeof value === "number" || (typeof value === "string" && value.trim() !== "")) {
    const numericValue = parseNumber(value);
    if (numericValue !== null && looksLikeTimeField(key)) {
      if (numericValue >= 1_000_000_000 && numericValue < 10_000_000_000) {
        return numericValue * 1000;
      }

      if (numericValue >= 1_000_000_000_000 && numericValue < 100_000_000_000_000) {
        return numericValue;
      }
    }
  }

  if (typeof value === "string" && (looksLikeTimeField(key) || looksLikeDateString(value))) {
    const timestamp = Date.parse(value);
    if (Number.isFinite(timestamp)) return timestamp;
  }

  return null;
};

const flattenRecord = (record: JsonRecord, row: DataRow, prefix = "") => {
  for (const [key, value] of Object.entries(record)) {
    const nextKey = prefix ? `${prefix}.${key}` : key;

    if (isRecord(value)) {
      flattenRecord(value, row, nextKey);
      continue;
    }

    row[nextKey] = Array.isArray(value) ? stringifyValue(value) : value;
  }
};

const normalizeArrayRows = (items: unknown[], pathSegments: string[]) =>
  items.map((item, index) => {
    const row: DataRow = {
      [INDEX_FIELD]: index + 1,
      [SOURCE_FIELD]: toPathLabel(pathSegments),
    };

    pathSegments.forEach((segment, segmentIndex) => {
      row[`${GROUP_PREFIX}${segmentIndex + 1}`] = segment;
    });

    if (isRecord(item)) {
      flattenRecord(item, row);
    } else {
      row.value = item;
    }

    return row;
  });

const profileColumns = (rows: DataRow[]): ColumnProfile[] => {
  const keys: string[] = [];
  const knownKeys = new Set<string>();

  for (const row of rows) {
    for (const key of Object.keys(row)) {
      if (!knownKeys.has(key)) {
        knownKeys.add(key);
        keys.push(key);
      }
    }
  }

  return keys.map((key) => {
    if (key === INDEX_FIELD) {
      return {
        key,
        label: getColumnLabel(key),
        kind: "number",
        nonEmptyCount: rows.length,
        numericCount: rows.length,
        timeCount: 0,
      };
    }

    if (key === SOURCE_FIELD || key.startsWith(GROUP_PREFIX)) {
      return {
        key,
        label: getColumnLabel(key),
        kind: "text",
        nonEmptyCount: rows.filter((row) => row[key] !== null && row[key] !== undefined && row[key] !== "").length,
        numericCount: 0,
        timeCount: 0,
      };
    }

    let nonEmptyCount = 0;
    let numericCount = 0;
    let timeCount = 0;
    let booleanCount = 0;

    for (const row of rows) {
      const value = row[key];
      if (value === null || value === undefined || value === "") continue;

      nonEmptyCount += 1;
      if (parseNumber(value) !== null) numericCount += 1;
      if (parseTime(value, key) !== null) timeCount += 1;
      if (typeof value === "boolean") booleanCount += 1;
    }

    const kind: ColumnKind =
      nonEmptyCount > 0 && timeCount / nonEmptyCount >= 0.85
        ? "time"
        : nonEmptyCount > 0 && numericCount / nonEmptyCount >= 0.85
          ? "number"
          : nonEmptyCount > 0 && booleanCount / nonEmptyCount >= 0.85
            ? "boolean"
            : "text";

    return {
      key,
      label: getColumnLabel(key),
      kind,
      nonEmptyCount,
      numericCount,
      timeCount,
    };
  });
};

const createTable = (id: string, label: string, path: string, rows: DataRow[], combined = false): DataTable => ({
  id,
  label,
  path,
  rows,
  columns: profileColumns(rows),
  sourceCount: new Set(rows.map((row) => stringifyValue(row[SOURCE_FIELD]))).size,
  combined,
});

const collectArrayTables = (value: unknown, pathSegments: string[] = []): DataTable[] => {
  if (Array.isArray(value)) {
    const rows = normalizeArrayRows(value, pathSegments);
    const currentTable =
      rows.length > 0
        ? [
            createTable(
              `table:${pathSegments.join(".") || "root"}`,
              pathSegments.length ? toPathLabel(pathSegments) : "根数组",
              pathSegments.join(".") || "$",
              rows,
            ),
          ]
        : [];

    const nestedTables = value.flatMap((item, index) =>
      isRecord(item) || Array.isArray(item)
        ? collectArrayTables(item, [...pathSegments, String(index + 1)])
        : [],
    );

    return [...currentTable, ...nestedTables];
  }

  if (!isRecord(value)) return [];

  return Object.entries(value).flatMap(([key, child]) => collectArrayTables(child, [...pathSegments, key]));
};

const getSignature = (table: DataTable) =>
  table.columns
    .map((column) => column.key)
    .filter((key) => !isGeneratedField(key))
    .sort()
    .join("\u0001");

const addCombinedTables = (tables: DataTable[]) => {
  const groups = new Map<string, DataTable[]>();

  for (const table of tables) {
    const signature = getSignature(table);
    if (!signature) continue;
    groups.set(signature, [...(groups.get(signature) ?? []), table]);
  }

  const combinedTables = Array.from(groups.entries())
    .filter(([, group]) => group.length > 1)
    .map(([signature, group]) =>
      createTable(
        `combined:${signature}`,
        `合并 ${group.length} 个同结构数组`,
        group.map((table) => table.path).join(" + "),
        group.flatMap((table) => table.rows),
        true,
      ),
    );

  return [...tables, ...combinedTables];
};

const extractTables = (parsed: unknown) => {
  const arrayTables = addCombinedTables(collectArrayTables(parsed));

  if (arrayTables.length > 0) {
    return arrayTables;
  }

  if (isRecord(parsed)) {
    const row: DataRow = {
      [INDEX_FIELD]: 1,
      [SOURCE_FIELD]: "根对象",
    };
    flattenRecord(parsed, row);
    return [createTable("object:root", "根对象", "$", [row])];
  }

  return [
    createTable("value:root", "单值", "$", [
      {
        [INDEX_FIELD]: 1,
        [SOURCE_FIELD]: "根值",
        value: parsed,
      },
    ]),
  ];
};

const getDefaultTable = (tables: DataTable[]) =>
  tables.find((table) => table.combined && table.sourceCount > 1) ?? tables.find((table) => !table.combined) ?? tables[0];

const getPathFilterColumns = (table: DataTable) =>
  table.columns.filter((column) => column.key.startsWith(GROUP_PREFIX) && column.nonEmptyCount > 0);

const getDistinctValues = (rows: DataRow[], key: string) =>
  Array.from(new Set(rows.map((row) => stringifyValue(row[key])).filter(Boolean))).sort((left, right) =>
    left.localeCompare(right, "zh-CN"),
  );

const getDefaultPathFilters = (table: DataTable) =>
  Object.fromEntries(
    getPathFilterColumns(table).map((column) => [column.key, getDistinctValues(table.rows, column.key)[0] ?? ""]),
  );

const getDefaultXField = (table: DataTable) => {
  const timeField = table.columns.find((column) => column.kind === "time" && !isGeneratedField(column.key));
  if (timeField) return timeField.key;

  const textField = table.columns.find((column) => column.kind === "text" && !isGeneratedField(column.key));
  if (textField) return textField.key;

  const numericField = table.columns.find((column) => column.kind === "number" && !isGeneratedField(column.key));
  return numericField?.key ?? INDEX_FIELD;
};

const getDefaultYFields = (table: DataTable, xField: string) => {
  const fields = table.columns
    .filter((column) => column.kind === "number" && column.key !== xField && !isGeneratedField(column.key))
    .map((column) => column.key);

  return fields.length ? fields.slice(0, 3) : [];
};

const getXValue = (row: DataRow, key: string, kind: ColumnKind, chartType: ChartType) => {
  const value = row[key];

  if (kind === "time") return parseTime(value, key);
  if (kind === "number" && chartType !== "bar") return parseNumber(value);
  return stringifyValue(value);
};

const formatAxisValue = (value: unknown, kind: ColumnKind) => {
  if (kind === "time") {
    const time = typeof value === "number" ? value : parseTime(value, "");
    return time === null ? stringifyValue(value) : shortDateFormatter.format(new Date(time));
  }

  if (kind === "number") {
    const numericValue = parseNumber(value);
    return numericValue === null ? stringifyValue(value) : numberFormatter.format(numericValue);
  }

  return stringifyValue(value);
};

const formatTooltipValue = (value: unknown, kind: ColumnKind) => {
  if (kind === "time") {
    const time = typeof value === "number" ? value : parseTime(value, "");
    return time === null ? stringifyValue(value) : dateTimeFormatter.format(new Date(time));
  }

  if (kind === "number") {
    const numericValue = parseNumber(value);
    return numericValue === null ? stringifyValue(value) : numberFormatter.format(numericValue);
  }

  return stringifyValue(value);
};

export default function HomePage() {
  const [input, setInput] = useState("");
  const [tables, setTables] = useState<DataTable[]>([]);
  const [selectedTableId, setSelectedTableId] = useState("");
  const [xField, setXField] = useState("");
  const [yFields, setYFields] = useState<string[]>([]);
  const [pathFilters, setPathFilters] = useState<Record<string, string>>({});
  const [groupField, setGroupField] = useState("");
  const [chartType, setChartType] = useState<ChartType>("line");
  const [stacked, setStacked] = useState(false);
  const [message, setMessage] = useState<LoadMessage | null>(null);
  const [isLoadingExample, setIsLoadingExample] = useState(false);

  const selectedTable = useMemo(
    () => tables.find((table) => table.id === selectedTableId) ?? null,
    [selectedTableId, tables],
  );

  const xColumn = useMemo(
    () => selectedTable?.columns.find((column) => column.key === xField) ?? null,
    [selectedTable, xField],
  );

  const numericColumns = useMemo(
    () => selectedTable?.columns.filter((column) => column.kind === "number" && !isGeneratedField(column.key)) ?? [],
    [selectedTable],
  );

  const pathFilterColumns = useMemo(
    () => (selectedTable ? getPathFilterColumns(selectedTable) : []),
    [selectedTable],
  );

  const filteredRows = useMemo(() => {
    if (!selectedTable) return [];

    const activeFilters = Object.entries(pathFilters).filter(([, value]) => value);
    if (!activeFilters.length) return selectedTable.rows;

    return selectedTable.rows.filter((row) =>
      activeFilters.every(([key, value]) => stringifyValue(row[key]) === value),
    );
  }, [pathFilters, selectedTable]);

  const automaticGroupColumns = useMemo(
    () => pathFilterColumns.filter((column) => !pathFilters[column.key]),
    [pathFilterColumns, pathFilters],
  );

  const seriesGroupColumns = useMemo(() => {
    if (!selectedTable) return [];

    const groupKeys = [
      ...automaticGroupColumns.map((column) => column.key),
      ...(groupField ? [groupField] : []),
    ];
    const uniqueGroupKeys = Array.from(new Set(groupKeys));

    return uniqueGroupKeys
      .map((key) => selectedTable.columns.find((column) => column.key === key))
      .filter((column): column is ColumnProfile => Boolean(column));
  }, [automaticGroupColumns, groupField, selectedTable]);

  const groupColumns = useMemo(
    () =>
      selectedTable?.columns.filter(
        (column) =>
          column.key !== xField &&
          !isGeneratedField(column.key) &&
          !yFields.includes(column.key) &&
          column.kind !== "number",
      ) ?? [],
    [selectedTable, xField, yFields],
  );

  const loadFromText = useCallback((text: string, successText = "数据已加载。") => {
    try {
      const parsed = JSON.parse(text);
      const extractedTables = extractTables(parsed).filter((table) => table.rows.length > 0);

      if (!extractedTables.length) {
        throw new Error("没有找到可展示的数据。请提供对象、数组，或包含数组的对象。");
      }

      const defaultTable = getDefaultTable(extractedTables);
      const defaultX = getDefaultXField(defaultTable);
      const defaultY = getDefaultYFields(defaultTable, defaultX);

      setTables(extractedTables);
      setSelectedTableId(defaultTable.id);
      setXField(defaultX);
      setYFields(defaultY);
      setPathFilters(getDefaultPathFilters(defaultTable));
      setGroupField("");
      setChartType(defaultY.length ? "line" : "bar");
      setStacked(false);
      setMessage({ type: "success", text: `${successText} 已识别 ${extractedTables.length} 个数据表。` });
    } catch (error) {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "JSON 数据无法解析。",
      });
    }
  }, []);

  const handleLoadInput = () => {
    if (!input.trim()) {
      setMessage({ type: "error", text: "请先粘贴 JSON 数据。" });
      return;
    }

    loadFromText(input);
  };

  const handleLoadExample = useCallback(async () => {
    setIsLoadingExample(true);
    try {
      const response = await fetch(`${basePath}/aio.json`);
      if (!response.ok) {
        throw new Error("示例数据加载失败，请稍后重试。");
      }

      const text = await response.text();
      setInput(text);
      loadFromText(text, "示例数据已加载。");
    } catch (error) {
      setMessage({
        type: "error",
        text: error instanceof Error ? error.message : "示例数据加载失败。",
      });
    } finally {
      setIsLoadingExample(false);
    }
  }, [loadFromText]);

  useEffect(() => {
    handleLoadExample();
  }, [handleLoadExample]);

  const handleSelectTable = (tableId: string) => {
    const table = tables.find((item) => item.id === tableId);
    if (!table) return;

    const defaultX = getDefaultXField(table);
    const defaultY = getDefaultYFields(table, defaultX);

    setSelectedTableId(table.id);
    setXField(defaultX);
    setYFields(defaultY);
    setPathFilters(getDefaultPathFilters(table));
    setGroupField("");
    setStacked(false);
  };

  const handleSelectXField = (field: string) => {
    setXField(field);
    setYFields((current) => current.filter((key) => key !== field));
    if (groupField === field) setGroupField("");
  };

  const handleSelectPathFilter = (field: string, value: string) => {
    setPathFilters((current) => ({
      ...current,
      [field]: value,
    }));
  };

  const toggleYField = (field: string) => {
    setYFields((current) =>
      current.includes(field) ? current.filter((key) => key !== field) : [...current, field],
    );
    if (groupField === field) setGroupField("");
  };

  const handleClear = () => {
    setInput("");
    setTables([]);
    setSelectedTableId("");
    setXField("");
    setYFields([]);
    setPathFilters({});
    setGroupField("");
    setStacked(false);
    setMessage(null);
  };

  const chartSeries = useMemo(() => {
    if (!selectedTable || !xField || !xColumn || yFields.length === 0) return [];

    const groups = new Map<string, DataRow[]>();

    if (seriesGroupColumns.length > 0) {
      for (const row of filteredRows) {
        const groupName = seriesGroupColumns
          .map((column) => stringifyValue(row[column.key]) || "空值")
          .join(" / ");
        groups.set(groupName, [...(groups.get(groupName) ?? []), row]);
      }
    } else {
      groups.set("", filteredRows);
    }

    return Array.from(groups.entries())
      .flatMap(([groupName, rows]) =>
        yFields.map((field) => {
          const sortedRows = [...rows].sort((left, right) => {
            const leftValue = getXValue(left, xField, xColumn.kind, chartType);
            const rightValue = getXValue(right, xField, xColumn.kind, chartType);

            if (typeof leftValue === "number" && typeof rightValue === "number") return leftValue - rightValue;
            return stringifyValue(leftValue).localeCompare(stringifyValue(rightValue), "zh-CN");
          });

          return {
            name: groupName ? `${groupName} / ${field}` : field,
            type: chartType,
            stack: stacked && chartType !== "scatter" ? "stack" : undefined,
            smooth: chartType === "line",
            showSymbol: chartType === "scatter" || sortedRows.length <= 80,
            symbolSize: chartType === "scatter" ? 7 : 5,
            data: sortedRows
              .map((row) => {
                const xValue = getXValue(row, xField, xColumn.kind, chartType);
                const yValue = parseNumber(row[field]);
                if (xValue === null || yValue === null) return null;
                return [xValue, yValue];
              })
              .filter((item): item is [string | number, number] => item !== null),
          };
        }),
      )
      .filter((series) => series.data.length > 0)
      .slice(0, MAX_SERIES_COUNT);
  }, [chartType, filteredRows, selectedTable, seriesGroupColumns, stacked, xColumn, xField, yFields]);

  const chartOption = useMemo(() => {
    const xAxisType =
      xColumn?.kind === "time" ? "time" : xColumn?.kind === "number" && chartType !== "bar" ? "value" : "category";

    return {
      color: palette,
      animationDuration: 220,
      tooltip: {
        trigger: "axis",
        confine: true,
        formatter: (params: unknown) => {
          const items = Array.isArray(params) ? params : [params];
          const first = items[0] as { data?: [unknown, unknown]; axisValue?: unknown } | undefined;
          const xValue = Array.isArray(first?.data) ? first?.data[0] : first?.axisValue;
          const lines = xColumn ? [`${xColumn.label}: ${formatTooltipValue(xValue, xColumn.kind)}`] : [];

          for (const item of items as Array<{
            marker?: string;
            seriesName?: string;
            data?: [unknown, unknown];
            value?: unknown;
          }>) {
            const value = Array.isArray(item.data) ? item.data[1] : item.value;
            lines.push(`${item.marker ?? ""}${item.seriesName ?? ""}: <b>${formatTooltipValue(value, "number")}</b>`);
          }

          return lines.join("<br/>");
        },
      },
      legend: {
        type: "scroll",
        top: 0,
        itemGap: 14,
        textStyle: {
          color: "#536071",
        },
      },
      grid: {
        top: 48,
        right: 24,
        bottom: 54,
        left: 16,
        containLabel: true,
      },
      xAxis: {
        type: xAxisType,
        boundaryGap: chartType === "bar",
        axisLabel: {
          hideOverlap: true,
          formatter: (value: unknown) => (xColumn ? formatAxisValue(value, xColumn.kind) : stringifyValue(value)),
        },
      },
      yAxis: {
        type: "value",
        scale: true,
        splitNumber: 6,
        axisLabel: {
          margin: 12,
          formatter: (value: unknown) => formatAxisValue(value, "number"),
        },
      },
      dataZoom: [
        {
          type: "inside",
          filterMode: "none",
        },
        {
          type: "slider",
          height: 22,
          bottom: 14,
          filterMode: "none",
        },
      ],
      series: chartSeries,
    };
  }, [chartSeries, chartType, xColumn]);

  const selectedRows = selectedTable?.rows.length ?? 0;
  const visibleRows = filteredRows.length;
  const selectedColumns = selectedTable?.columns.length ?? 0;
  const chartReady = selectedTable && xField && yFields.length > 0 && chartSeries.length > 0;
  const detectedArrayTables = tables.filter((table) => !table.combined).length;
  const combinedTables = tables.filter((table) => table.combined).length;

  return (
    <main className="h-screen overflow-hidden bg-[var(--background)] text-[var(--foreground)]">
      <div className="grid h-full min-w-[1100px] grid-cols-[420px_minmax(0,1fr)]">
        <aside className="flex h-screen min-h-0 flex-col border-r border-[var(--border)] bg-[var(--surface)]">
          <header className="border-b border-[var(--border-subtle)] px-5 py-4">
            <p className="text-sm font-medium text-[var(--accent)]">JSON 图表工作台</p>
            <h1 className="mt-1 text-2xl font-semibold leading-tight">通用数据可视化</h1>
          </header>

          <div className="flex min-h-0 flex-1 flex-col gap-4 overflow-y-auto p-5">
            <section className="flex flex-col gap-3">
              <div className="flex items-start justify-between gap-3">
                <div>
                  <h2 className="text-base font-semibold">输入数据</h2>
                  <p className="mt-1 text-sm leading-6 text-[var(--muted)]">支持数组、对象，以及对象中嵌套的数组。</p>
                </div>
                <button
                  type="button"
                  onClick={handleClear}
                  className="rounded-md px-3 py-2 text-sm font-semibold text-[var(--muted)] transition hover:bg-[var(--surface-muted)] hover:text-[var(--foreground)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)]"
                >
                  清空
                </button>
              </div>

              <textarea
                value={input}
                onChange={(event) => setInput(event.target.value)}
                spellCheck={false}
                placeholder='例如：[{"date":"2026-06-01","sales":120,"region":"华东"}]'
                className="h-[220px] resize-none rounded-md border border-[var(--border)] bg-[var(--surface-muted)] p-3 font-mono text-xs leading-5 text-[var(--foreground)] outline-none transition focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-ring)]"
              />

              <div className="grid grid-cols-2 gap-2">
                <button
                  type="button"
                  onClick={handleLoadInput}
                  className="min-h-11 rounded-md bg-[var(--accent)] px-4 py-2 text-sm font-semibold text-white transition hover:bg-[var(--accent-strong)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)]"
                >
                  解析数据
                </button>
                <button
                  type="button"
                  onClick={handleLoadExample}
                  disabled={isLoadingExample}
                  className="min-h-11 rounded-md border border-[var(--border)] px-4 py-2 text-sm font-semibold text-[var(--foreground)] transition hover:bg-[var(--surface-muted)] focus:outline-none focus:ring-2 focus:ring-[var(--accent-ring)] disabled:cursor-not-allowed disabled:opacity-60"
                >
                  {isLoadingExample ? "加载中..." : "加载示例"}
                </button>
              </div>

              {message && (
                <div
                  role={message.type === "error" ? "alert" : "status"}
                  className={`rounded-md border px-3 py-2 text-sm leading-6 ${
                    message.type === "error"
                      ? "border-[var(--danger-border)] bg-[var(--danger-surface)] text-[var(--danger)]"
                      : "border-[var(--success-border)] bg-[var(--success-surface)] text-[var(--success)]"
                  }`}
                >
                  {message.text}
                </div>
              )}
            </section>

            <section className="flex flex-col gap-3 border-t border-[var(--border-subtle)] pt-4">
              <div>
                <h2 className="text-base font-semibold">数据结构</h2>
                <p className="mt-1 text-sm text-[var(--muted)]">
                  已识别 {detectedArrayTables} 个数组，{combinedTables} 个合并视图。
                </p>
              </div>

              <label className="flex flex-col gap-1 text-sm">
                <span className="font-medium">数据表</span>
                <select
                  value={selectedTableId}
                  onChange={(event) => handleSelectTable(event.target.value)}
                  disabled={!tables.length}
                  className="min-h-11 rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-3 outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-ring)]"
                >
                  {tables.map((table) => (
                    <option key={table.id} value={table.id}>
                      {table.label} · {table.rows.length} 行
                    </option>
                  ))}
                </select>
              </label>

              {selectedTable && pathFilterColumns.length > 0 && (
                <div className="flex flex-col gap-2">
                  <div className="text-sm font-medium">路径筛选</div>
                  <div className="grid grid-cols-2 gap-2">
                    {pathFilterColumns.map((column) => {
                      const values = getDistinctValues(selectedTable.rows, column.key);

                      return (
                        <label key={column.key} className="flex min-w-0 flex-col gap-1 text-sm">
                          <span className="truncate text-[var(--muted)]">{column.label}</span>
                          <select
                            value={pathFilters[column.key] ?? ""}
                            onChange={(event) => handleSelectPathFilter(column.key, event.target.value)}
                            className="min-h-10 min-w-0 rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-3 outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-ring)]"
                          >
                            <option value="">全部</option>
                            {values.map((value) => (
                              <option key={value} value={value}>
                                {value}
                              </option>
                            ))}
                          </select>
                        </label>
                      );
                    })}
                  </div>
                  {automaticGroupColumns.length > 0 && (
                    <p className="text-xs leading-5 text-[var(--muted)]">
                      选择“全部”的路径会自动拆分为系列：{automaticGroupColumns.map((column) => column.label).join("、")}。
                    </p>
                  )}
                </div>
              )}

              <div className="grid grid-cols-3 gap-2 text-sm">
                <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-3 py-2">
                  <div className="text-[var(--muted)]">行数</div>
                  <div className="font-semibold">
                    {visibleRows}
                    {visibleRows !== selectedRows ? `/${selectedRows}` : ""}
                  </div>
                </div>
                <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-3 py-2">
                  <div className="text-[var(--muted)]">字段</div>
                  <div className="font-semibold">{selectedColumns}</div>
                </div>
                <div className="rounded-md border border-[var(--border-subtle)] bg-[var(--surface-muted)] px-3 py-2">
                  <div className="text-[var(--muted)]">系列</div>
                  <div className="font-semibold">{chartSeries.length}</div>
                </div>
              </div>
            </section>

            {selectedTable && (
              <section className="flex flex-col gap-3 border-t border-[var(--border-subtle)] pt-4">
                <h2 className="text-base font-semibold">绘图字段</h2>

                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">X 轴</span>
                  <select
                    value={xField}
                    onChange={(event) => handleSelectXField(event.target.value)}
                    className="min-h-11 rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-3 outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-ring)]"
                  >
                    {selectedTable.columns.map((column) => (
                      <option key={column.key} value={column.key}>
                        {column.label} · {column.kind}
                      </option>
                    ))}
                  </select>
                </label>

                <div className="flex flex-col gap-2">
                  <div className="text-sm font-medium">Y 轴数值</div>
                  <div className="grid max-h-40 grid-cols-2 gap-2 overflow-y-auto pr-1">
                    {numericColumns.map((column) => (
                      <label
                        key={column.key}
                        className="flex min-h-10 min-w-0 items-center gap-2 rounded-md border border-[var(--border)] px-3 text-sm"
                        title={column.key}
                      >
                        <input
                          type="checkbox"
                          checked={yFields.includes(column.key)}
                          disabled={column.key === xField}
                          onChange={() => toggleYField(column.key)}
                        />
                        <span className="truncate">{column.label}</span>
                      </label>
                    ))}
                  </div>
                  {!numericColumns.length && <p className="text-sm text-[var(--muted)]">没有识别到数值字段。</p>}
                </div>

                <label className="flex flex-col gap-1 text-sm">
                  <span className="font-medium">系列分组</span>
                  <select
                    value={groupField}
                    onChange={(event) => setGroupField(event.target.value)}
                    className="min-h-11 rounded-md border border-[var(--border)] bg-[var(--surface-muted)] px-3 outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-ring)]"
                  >
                    <option value="">不分组</option>
                    {groupColumns.map((column) => (
                      <option key={column.key} value={column.key}>
                        {column.label}
                      </option>
                    ))}
                  </select>
                </label>
              </section>
            )}
          </div>
        </aside>

        <section className="flex h-screen min-h-0 min-w-0 flex-col bg-[var(--background)]">
          <header className="flex items-start justify-between gap-4 border-b border-[var(--border-subtle)] px-6 py-4">
            <div className="min-w-0">
              <h2 className="text-xl font-semibold">图表预览</h2>
              <p className="mt-1 truncate text-sm text-[var(--muted)]">
                {selectedTable ? `${selectedTable.label} · X: ${xField || "-"} · Y: ${yFields.join(", ") || "-"}` : "等待数据"}
              </p>
            </div>

            <div className="flex shrink-0 items-center gap-3">
              <select
                value={chartType}
                onChange={(event) => setChartType(event.target.value as ChartType)}
                className="min-h-11 rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-sm outline-none focus:border-[var(--accent)] focus:ring-2 focus:ring-[var(--accent-ring)]"
              >
                {chartTypes.map((item) => (
                  <option key={item.value} value={item.value}>
                    {item.label}
                  </option>
                ))}
              </select>

              <label className="flex min-h-11 items-center gap-2 whitespace-nowrap rounded-md border border-[var(--border)] bg-[var(--surface)] px-3 text-sm">
                <input
                  type="checkbox"
                  checked={stacked}
                  disabled={chartType === "scatter"}
                  onChange={(event) => setStacked(event.target.checked)}
                />
                <span>堆叠</span>
              </label>
            </div>
          </header>

          <div className="min-h-0 flex-1 p-5">
            <div className="flex h-full min-h-0 rounded-lg border border-[var(--border)] bg-[var(--surface)] p-4">
              {chartReady ? (
                <ReactECharts option={chartOption} notMerge lazyUpdate style={{ width: "100%", height: "100%" }} />
              ) : (
                <div className="flex h-full w-full items-center justify-center rounded-md border border-dashed border-[var(--border)] bg-[var(--surface-muted)] px-4 text-center text-sm text-[var(--muted)]">
                  选择一个 X 轴字段和至少一个数值字段后生成图表。
                </div>
              )}
            </div>
          </div>
        </section>
      </div>
    </main>
  );
}
