"use client";

import { useState, useMemo } from "react";
import dynamic from "next/dynamic";

const ReactECharts = dynamic(() => import("echarts-for-react"), { ssr: false });

// 自动单位化函数
const formatBytes = (bytes: number) => {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB', 'PB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  const value = bytes / Math.pow(k, i);
  const formatted = value >= 100 ? value.toFixed(0) : value.toFixed(2);
  return `${formatted} ${sizes[i]}`;
};

export default function HomePage() {
  const [input, setInput] = useState("");
  const [rawData, setRawData] = useState<Record<string, Record<string, any[]>>>({});
  const [timeRange, setTimeRange] = useState("");
  const [region, setRegion] = useState("");
  const [stacked, setStacked] = useState(false);
  const [showRx, setShowRx] = useState(true);
  const [showTx, setShowTx] = useState(true);

  // 加载 JSON 数据
  const handleLoadData = () => {
    try {
      const parsed = JSON.parse(input);
      setRawData(parsed);

      // 默认选第一个时间区间
      const firstRegion = Object.keys(parsed)[0];
      const firstTimeRange = Object.keys(parsed[firstRegion])[0];
      setTimeRange(firstTimeRange);
      setRegion(firstRegion);
    } catch (e) {
      alert("JSON 格式错误！");
    }
  };

  // 所有时间区间
  const allTimeRanges = useMemo(
    () => Object.keys(rawData).length ? Array.from(new Set(Object.values(rawData).flatMap(r => Object.keys(r)))) : [],
    [rawData]
  );

  // 切换 RX/TX 保证至少一个选中
  const toggleRx = () => { if (showTx) setShowRx(prev => !prev); };
  const toggleTx = () => { if (showRx) setShowTx(prev => !prev); };

  // 动态生成 xAxis
  const xAxisData = useMemo(() => {
    if (!timeRange) return [];
    if (region === "All") {
      const firstRegionWithData = Object.keys(rawData).find(r => rawData[r][timeRange]);
      return firstRegionWithData ? rawData[firstRegionWithData][timeRange].map(d => new Date(d.timestamp * 1000).toLocaleString()) : [];
    } else {
      return rawData[region][timeRange]?.map(d => new Date(d.timestamp * 1000).toLocaleString()) || [];
    }
  }, [rawData, region, timeRange]);

  // 动态生成 series
  const series = useMemo(() => {
    if (!timeRange) return [];
    if (region === "All") {
      return Object.keys(rawData).flatMap(r => {
        const data = rawData[r][timeRange];
        if (!data) return [];
        const s: any[] = [];
        if (showRx) s.push({ name: `${r} RX`, type: "line", stack: stacked ? "stack" : undefined, smooth: true, data: data.map(d => d.rx) });
        if (showTx) s.push({ name: `${r} TX`, type: "line", stack: stacked ? "stack" : undefined, smooth: true, data: data.map(d => d.tx) });
        return s;
      });
    } else {
      const data = rawData[region][timeRange] || [];
      const s: any[] = [];
      if (showRx) s.push({ name: "RX", type: "line", stack: stacked ? "stack" : undefined, smooth: true, data: data.map(d => d.rx) });
      if (showTx) s.push({ name: "TX", type: "line", stack: stacked ? "stack" : undefined, smooth: true, data: data.map(d => d.tx) });
      return s;
    }
  }, [rawData, region, timeRange, showRx, showTx, stacked]);

  const option = useMemo(() => ({
    title: { text: `网络流量趋势 - ${region} / ${timeRange}` },
    tooltip: { trigger: "axis", formatter: (params: any) => params.map((p: any) => `${p.seriesName}: ${formatBytes(p.data)}`).join("<br/>") },
    legend: { data: series.map(s => s.name) },
    xAxis: { type: "category", data: xAxisData },
    yAxis: { type: "value", axisLabel: { formatter: (v: number) => formatBytes(v) } },
    series
  }), [series, xAxisData, region, timeRange]);

  return (
    <div className="p-6 space-y-6">
      <h1 className="text-2xl font-bold">ECharts 多地区/时间区间绘图</h1>

      <textarea
        value={input}
        onChange={e => setInput(e.target.value)}
        placeholder='粘贴 JSON 数据，格式：{ "北京": { "时间段": [{timestamp,rx,tx}] } }'
        className="w-full h-40 border rounded p-2 font-mono"
      />
      <button onClick={handleLoadData} className="px-4 py-2 bg-blue-600 text-white rounded">加载数据</button>

      {allTimeRanges.length > 0 && (
        <div className="space-y-4">
          <div className="flex space-x-4 items-center">
            <select value={timeRange} onChange={e => { setTimeRange(e.target.value); setRegion(Object.keys(rawData)[0]); }} className="border rounded p-1">
              {allTimeRanges.map(t => <option key={t} value={t}>{t}</option>)}
            </select>

            <select value={region} onChange={e => setRegion(e.target.value)} className="border rounded p-1">
              <option value="All">All</option>
              {Object.keys(rawData).map(r => <option key={r} value={r}>{r}</option>)}
            </select>

            <label className="flex items-center space-x-1">
              <input type="checkbox" checked={stacked} onChange={e => setStacked(e.target.checked)} />
              <span>堆叠显示</span>
            </label>

            <label className="flex items-center space-x-1">
              <input type="checkbox" checked={showRx} onChange={toggleRx} />
              <span>显示 RX</span>
            </label>

            <label className="flex items-center space-x-1">
              <input type="checkbox" checked={showTx} onChange={toggleTx} />
              <span>显示 TX</span>
            </label>
          </div>

          <ReactECharts option={option} style={{ height: 500 }} />
        </div>
      )}
    </div>
  );
}
