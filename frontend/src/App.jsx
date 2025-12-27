import React, { useState, useMemo } from 'react';
import axios from 'axios';
import * as XLSX from 'xlsx';
import { 
  LayoutDashboard, Database, Play, Box, Truck, BarChart3, 
  UploadCloud, FileText, Loader2, Search, ClipboardList, AlertCircle,
  Settings, ChevronRight, ChevronDown, Share2, Download, Trash2, CheckCircle2, Factory,
  TrendingUp, AlertTriangle, Target, Activity
} from 'lucide-react';
import { 
  BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, 
  AreaChart, Area, PieChart, Pie, Cell, Legend 
} from 'recharts';

// React Flow Imports
import { ReactFlow, Background, Controls, MarkerType, Handle, Position } from '@xyflow/react';
import '@xyflow/react/dist/style.css';

// --- HELPERS ---
const formatNum = (val) => {
  if (val === undefined || val === null || val === '-') return '-';
  const n = Number(val);
  if (isNaN(n)) return '-';
  if (Math.abs(n) < 0.00001) return '0';
  return n.toLocaleString(undefined, { 
    minimumFractionDigits: 0, 
    maximumFractionDigits: 2 
  });
};

const COLORS = ['#6366f1', '#f59e0b', '#ef4444', '#10b981', '#64748b'];

// --- CUSTOM GRAPH NODES ---
const MaterialNode = ({ data }) => (
  <div className="flex flex-col items-center group relative p-4">
    <Handle type="target" position={Position.Left} className="w-2 h-2 !bg-indigo-400 border-none" />
    <div className="w-0 h-0 border-l-[30px] border-l-transparent border-r-[30px] border-r-transparent border-b-[50px] border-b-indigo-600 drop-shadow-md transition-transform group-hover:scale-110 relative">
       <span className="absolute top-6 left-1/2 -translate-x-1/2 text-[7px] font-black text-white uppercase tracking-tighter">{data.type}</span>
    </div>
    <div className="mt-2 text-[10px] font-bold bg-white px-3 py-1 rounded-full shadow-sm border border-slate-200 whitespace-nowrap">{data.label}</div>
    <Handle type="source" position={Position.Right} className="w-2 h-2 !bg-indigo-400 border-none" />
  </div>
);

const ActivityNode = ({ data }) => (
  <div className="flex flex-col items-center group relative p-4">
    <Handle type="target" position={Position.Left} className="w-2 h-2 !bg-amber-400 border-none" />
    <div className="w-14 h-14 rounded-full bg-amber-50 border-2 border-amber-400 flex items-center justify-center shadow-md transition-all group-hover:border-amber-600 group-hover:bg-amber-100">
      <span className="text-[8px] font-black text-amber-700 text-center px-1 leading-tight uppercase">{data.label}</span>
    </div>
    <Handle type="source" position={Position.Right} className="w-2 h-2 !bg-amber-400 border-none" />
  </div>
);

const nodeTypes = { material: MaterialNode, activity: ActivityNode };

export default function App() {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [activeTab, setActiveTab] = useState('data'); 
  const [selectedItem, setSelectedItem] = useState('');
  const [selectedTrace, setSelectedTrace] = useState(null);
  const [isConstrained, setIsConstrained] = useState(true);
  const [buildAhead, setBuildAhead] = useState(true);
  const [expandInflow, setExpandInflow] = useState(false);
  const [expandOutflow, setExpandOutflow] = useState(false);

  // --- SOLVER METRICS CALCULATION ---
  const metrics = useMemo(() => {
    if (!result) return null;

    // 1. Demand & Fulfillment
    const totalDemandQty = result.trace.reduce((sum, t) => sum + (t.qty || 0), 0);
    const onTimeOrders = result.trace.filter(t => !t.steps.some(s => s.action === 'Infeasible')).length;
    const fulfillmentRate = ((onTimeOrders / result.trace.length) * 100).toFixed(1);

    // 2. Global Shortages
    let totalShortageQty = 0;
    const itemShortages = [];
    Object.keys(result.mrp).forEach(item => {
      const itemSum = Object.values(result.mrp[item]).reduce((s, b) => s + (b.shortage || 0), 0);
      totalShortageQty += itemSum;
      if (itemSum > 0) itemShortages.push({ item, qty: itemSum });
    });

    // 3. Constraint Analysis (Pie Chart Data)
    const constraints = {};
    result.trace.forEach(t => {
      t.steps.filter(s => s.action === 'Infeasible').forEach(s => {
        const reason = s.reason || "Unknown";
        constraints[reason] = (constraints[reason] || 0) + 1;
      });
    });
    const pieData = Object.keys(constraints).map(name => ({ name, value: constraints[name] }));

    // 4. Cumulative Supply vs Demand (Area Chart Data)
    const dates = Object.keys(result.mrp[Object.keys(result.mrp)[0]]);
    let cumDemand = 0, cumSupply = 0;
    const cumulativeData = dates.map(d => {
      let dailyDemand = 0, dailySupply = 0;
      Object.keys(result.mrp).forEach(item => {
        const bucket = result.mrp[item][d];
        dailyDemand += (bucket.outflow_direct || 0);
        dailySupply += (bucket.inflow_fresh || 0) + (bucket.inflow_onhand || 0) + (bucket.inflow_wip || 0);
      });
      cumDemand += dailyDemand;
      cumSupply += dailySupply;
      return { date: d, Demand: cumDemand, Supply: cumSupply };
    });

    return { 
      totalDemandQty, fulfillmentRate, onTimeOrders, totalShortageQty, 
      pieData, cumulativeData, 
      criticalItems: itemShortages.sort((a,b) => b.qty - a.qty).slice(0, 5)
    };
  }, [result]);

  const handleSolve = async () => {
    setLoading(true);
    const formData = new FormData();
    files.forEach(file => formData.append('files', file));
    formData.append('horizon', 30);
    formData.append('start_date', "2025-12-01"); 
    formData.append('is_constrained', isConstrained);
    formData.append('build_ahead', buildAhead);

    try {
      const response = await axios.post('http://localhost:8000/solve', formData);
      setResult(response.data);
      if (response.data.raw_data?.items?.length > 0) setSelectedItem(response.data.raw_data.items[0].ItemID);
      if (response.data.trace) setSelectedTrace(response.data.trace[0]);
      setActiveTab('executive');
    } catch (error) { console.error("Solver Error:", error); } 
    finally { setLoading(false); }
  };

  const handleExportPurchases = () => {
    if (!result?.planned_orders) return;
    const purchases = result.planned_orders.filter(o => o.type === 'Purchase');
    const data = purchases.map(o => ({ "Order ID": o.id, "Purchase Date": o.start, "Arrival Date": o.finish, "Supplier": o.supplier, "Item": o.item, "Qty": o.qty }));
    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Purchase Plan");
    XLSX.writeFile(workbook, `global_purchase_plan_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  const handleExportProduction = () => {
    if (!result?.planned_orders) return;
    const production = result.planned_orders.filter(o => o.type === 'Production');
    const data = production.map(o => ({ "Order ID": o.id, "Item": o.item, "Resource": o.res || 'Internal', "Qty": o.qty, "Start Date": o.start, "Finish Date": o.finish }));
    const worksheet = XLSX.utils.json_to_sheet(data);
    const workbook = XLSX.utils.book_new();
    XLSX.utils.book_append_sheet(workbook, worksheet, "Production Plan");
    XLSX.writeFile(workbook, `production_plan_${new Date().toISOString().split('T')[0]}.xlsx`);
  };

  const { nodes, edges } = useMemo(() => {
    if (!result?.raw_data || !selectedItem) return { nodes: [], edges: [] };
    const newNodes = [], newEdges = [], visited = new Set();
    const { bom, supplier_master, items } = result.raw_data;
    const traceUpstream = (itemId, x, y, level = 0) => {
      const nodeKey = `${itemId}_${level}`;
      if (visited.has(nodeKey)) return;
      visited.add(nodeKey);
      const itemInfo = items?.find(i => i.ItemID === itemId);
      const typeLabel = itemInfo?.Type || (itemId.startsWith('RM') ? 'RM' : 'WIP');
      newNodes.push({ id: itemId, type: 'material', data: { label: itemId, type: typeLabel }, position: { x, y } });
      const components = bom?.filter(b => b.ParentID === itemId) || [];
      components.forEach((comp, idx) => {
        const activityId = `act_bom_${itemId}_${comp.ChildID}_${comp.BOMId}`;
        const childY = y + (idx - (components.length - 1) / 2) * 220;
        newNodes.push({ id: activityId, type: 'activity', data: { label: comp.BOMId }, position: { x: x - 250, y: childY } });
        newEdges.push({ id: `e-${comp.ChildID}-${activityId}`, source: comp.ChildID, target: activityId, markerEnd: { type: MarkerType.ArrowClosed, color: '#6366f1' }, style: { stroke: '#6366f1', strokeWidth: 2 } });
        newEdges.push({ id: `e-${activityId}-${itemId}`, source: activityId, target: itemId, markerEnd: { type: MarkerType.ArrowClosed, color: '#6366f1' }, style: { stroke: '#6366f1', strokeWidth: 2 } });
        traceUpstream(comp.ChildID, x - 500, childY, level + 1);
      });
      const suppliers = supplier_master?.filter(s => s.ItemID === itemId) || [];
      suppliers.forEach((sup, idx) => {
        const activityId = `act_sup_${itemId}_${sup.SupplierID}`;
        const sourceId = `${itemId}_at_${sup.SupplierID}`;
        const supY = y + (idx + components.length - (suppliers.length - 1) / 2) * 220;
        newNodes.push({ id: activityId, type: 'activity', data: { label: sup.SupplierName }, position: { x: x - 250, y: supY } });
        newNodes.push({ id: sourceId, type: 'material', data: { label: `${itemId} (Supplier)`, type: 'RM' }, position: { x: x - 500, y: supY } });
        newEdges.push({ id: `e-s1-${activityId}`, source: sourceId, target: activityId, markerEnd: { type: MarkerType.ArrowClosed, color: '#f59e0b' }, style: { stroke: '#f59e0b', strokeWidth: 2, strokeDasharray: '5,5' } });
        newEdges.push({ id: `e-s2-${activityId}`, source: activityId, target: itemId, markerEnd: { type: MarkerType.ArrowClosed, color: '#f59e0b' }, style: { stroke: '#f59e0b', strokeWidth: 2, strokeDasharray: '5,5' } });
      });
    };
    traceUpstream(selectedItem, 1200, 400);
    return { nodes: newNodes, edges: newEdges };
  }, [result, selectedItem]);

  return (
    <div className="flex h-screen bg-[#F8FAFC] text-slate-900 font-sans overflow-hidden">
      <aside className="w-64 bg-[#0F172A] text-white flex flex-col shadow-2xl">
        <div className="p-6 border-b border-slate-700 bg-[#1E293B] flex items-center gap-3">
          <div className="w-8 h-8 bg-indigo-500 rounded flex items-center justify-center"><Box size={20} /></div>
          <span className="font-bold text-sm tracking-widest uppercase">Upstrail APS</span>
        </div>
        <nav className="flex-1 p-4 space-y-1 mt-4 overflow-y-auto">
          <NavItem icon={<Database size={18}/>} label="Data Management" active={activeTab === 'data'} onClick={() => setActiveTab('data')} />
          <NavItem icon={<LayoutDashboard size={18}/>} label="Executive Summary" active={activeTab === 'executive'} onClick={() => setActiveTab('executive')} disabled={!result} />
          <NavItem icon={<ClipboardList size={18}/>} label="MRP Inventory Plan" active={activeTab === 'mrp'} onClick={() => setActiveTab('mrp')} disabled={!result} />
          <NavItem icon={<Share2 size={18}/>} label="Network Graph" active={activeTab === 'network'} onClick={() => setActiveTab('network')} disabled={!result} />
          <NavItem icon={<Truck size={18}/>} label="Production Plan" active={activeTab === 'plan'} onClick={() => setActiveTab('plan')} disabled={!result} />
          <NavItem icon={<Search size={18}/>} label="Trace RCA" active={activeTab === 'rca'} onClick={() => setActiveTab('rca')} disabled={!result} />
        </nav>
        <div className="p-4 bg-[#1E293B] border-t border-slate-700">
          <div className="flex items-center gap-2 mb-4 text-slate-400"><Settings size={14} /><span className="text-[10px] font-bold uppercase tracking-widest">Solver Parameters</span></div>
          <div className="space-y-4">
            <div className="flex items-center justify-between"><span className="text-xs font-medium text-slate-300">Constrained</span><button onClick={() => setIsConstrained(!isConstrained)} className={`w-8 h-4 rounded-full relative ${isConstrained ? 'bg-indigo-500' : 'bg-slate-600'}`}><div className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform ${isConstrained ? 'translate-x-4' : 'translate-x-0'}`} /></button></div>
            <div className="flex items-center justify-between"><span className="text-xs font-medium text-slate-300">Build Ahead</span><button onClick={() => setBuildAhead(!buildAhead)} className={`w-8 h-4 rounded-full relative ${buildAhead ? 'bg-indigo-500' : 'bg-slate-600'}`}><div className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform ${buildAhead ? 'translate-x-4' : 'translate-x-0'}`} /></button></div>
          </div>
        </div>
      </aside>

      <main className="flex-1 flex flex-col overflow-hidden">
        <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-8 shadow-sm z-10">
          <h2 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Workspace / {activeTab}</h2>
          <button onClick={handleSolve} disabled={loading || files.length === 0} className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-1.5 rounded text-xs font-bold transition-all disabled:opacity-30 shadow-lg shadow-indigo-100">
            {loading ? <Loader2 className="animate-spin" size={14}/> : <Play size={14}/>} {loading ? "PROCESSING..." : "RUN SOLVER"}
          </button>
        </header>

        <div className="flex-1 overflow-auto p-8">
          {activeTab === 'data' && (
            <div className="max-w-4xl mx-auto">
              <div className="mb-8"><h3 className="text-lg font-bold text-slate-800">Supply Chain Master Data</h3><p className="text-xs text-slate-500 mt-1">Upload CSV or Excel files containing Demand, BOM, Items, and Resources.</p></div>
              <div className="bg-white rounded-xl border-2 border-dashed border-slate-200 p-12 text-center flex flex-col items-center justify-center transition-all hover:border-indigo-300">
                <UploadCloud size={48} className="text-slate-200 mb-4" />
                <h3 className="font-bold text-slate-700 mb-6 uppercase text-sm tracking-widest">Select Files</h3>
                <input type="file" multiple onChange={(e) => setFiles([...files, ...Array.from(e.target.files)])} className="hidden" id="f-up-page" />
                <label htmlFor="f-up-page" className="bg-indigo-600 text-white px-10 py-3 rounded font-bold text-xs cursor-pointer shadow-xl shadow-indigo-100 transition-transform active:scale-95">Browse Files</label>
              </div>
              {files.length > 0 && (
                <div className="mt-10 animate-in fade-in slide-in-from-bottom-4 duration-500">
                  <div className="flex items-center justify-between mb-4"><h4 className="text-[10px] font-black text-slate-400 uppercase tracking-widest">Staged Files ({files.length})</h4><button onClick={() => setFiles([])} className="text-[10px] font-black text-red-500 flex items-center gap-1 hover:underline"><Trash2 size={12}/> REMOVE ALL</button></div>
                  <div className="grid grid-cols-2 gap-4">
                    {files.map((f, idx) => (
                      <div key={idx} className="bg-white p-4 rounded-lg border border-slate-200 flex items-center justify-between group">
                        <div className="flex items-center gap-3"><div className="w-8 h-8 bg-indigo-50 text-indigo-600 rounded flex items-center justify-center"><FileText size={16}/></div><div><p className="text-xs font-bold text-slate-700 truncate max-w-[200px]">{f.name}</p><p className="text-[9px] text-slate-400 uppercase tracking-tighter">{(f.size / 1024).toFixed(1)} KB</p></div></div>
                        <CheckCircle2 size={16} className="text-emerald-500 opacity-0 group-hover:opacity-100 transition-opacity"/>
                      </div>
                    ))}
                  </div>
                </div>
              )}
            </div>
          )}

          {result && activeTab === 'executive' && metrics && (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
              {/* KPI Section */}
              <div className="grid grid-cols-4 gap-6">
                <KPICard label="Fulfillment Rate" value={`${metrics.fulfillmentRate}%`} icon={<Target className="text-indigo-500"/>} trend={metrics.fulfillmentRate > 90 ? "Healthy" : "Attention"} />
                <KPICard label="On-Time Delivery" value={metrics.onTimeOrders} icon={<Activity className="text-green-500"/>} trend={`of ${result.trace.length} Orders`} />
                <KPICard label="Total Shortages" value={formatNum(metrics.totalShortageQty)} icon={<AlertTriangle className="text-red-500"/>} />
                <KPICard label="Planned Qty" value={formatNum(metrics.totalDemandQty)} icon={<TrendingUp className="text-blue-500"/>} />
              </div>

              {/* Chart Section */}
              <div className="grid grid-cols-3 gap-6">
                <div className="col-span-2 bg-white p-6 rounded-xl border border-slate-200 shadow-sm h-[400px]">
                  <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-6">Cumulative Supply vs Demand</h3>
                  <ResponsiveContainer width="100%" height="90%">
                    <AreaChart data={metrics.cumulativeData}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis dataKey="date" fontSize={9} axisLine={false} tickLine={false} tick={{fill: '#94a3b8'}} />
                      <YAxis fontSize={9} axisLine={false} tickLine={false} tick={{fill: '#94a3b8'}} />
                      <Tooltip contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)' }} />
                      <Area type="monotone" dataKey="Demand" stroke="#cbd5e1" fill="#f8fafc" strokeWidth={2} />
                      <Area type="monotone" dataKey="Supply" stroke="#6366f1" fill="#eef2ff" strokeWidth={3} />
                      <Legend verticalAlign="top" align="right" iconType="circle" />
                    </AreaChart>
                  </ResponsiveContainer>
                </div>
                <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm h-[400px]">
                  <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-6">Constraint Analysis</h3>
                  <ResponsiveContainer width="100%" height="70%">
                    <PieChart>
                      <Pie data={metrics.pieData} innerRadius={60} outerRadius={80} paddingAngle={5} dataKey="value">
                        {metrics.pieData.map((entry, index) => <Cell key={`cell-${index}`} fill={COLORS[index % COLORS.length]} />)}
                      </Pie>
                      <Tooltip />
                    </PieChart>
                  </ResponsiveContainer>
                  <div className="mt-4 space-y-2">
                    {metrics.pieData.map((d, i) => (
                      <div key={i} className="flex items-center justify-between text-[10px] font-bold">
                        <div className="flex items-center gap-2"><div className="w-2 h-2 rounded-full" style={{backgroundColor: COLORS[i % COLORS.length]}}/> <span className="text-slate-500">{d.name}</span></div>
                        <span>{d.value}</span>
                      </div>
                    ))}
                  </div>
                </div>
              </div>

              {/* Actionable Insights */}
              <div className="grid grid-cols-2 gap-6">
                <div className="bg-white p-6 rounded-xl border border-slate-200">
                  <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4">Critical Items (Shortage Risk)</h3>
                  <div className="space-y-3">
                    {metrics.criticalItems.map((item, i) => (
                      <div key={i} className="flex justify-between items-center p-3 bg-red-50/50 rounded-lg border border-red-100">
                        <span className="text-xs font-black text-slate-700">{item.item}</span>
                        <span className="text-xs font-black text-red-600">{formatNum(item.qty)} Units</span>
                      </div>
                    ))}
                    {metrics.criticalItems.length === 0 && <p className="text-xs text-slate-400 italic">No shortages detected.</p>}
                  </div>
                </div>
                <div className="bg-white p-6 rounded-xl border border-slate-200">
                  <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-4">Recent System Logs</h3>
                  <div className="space-y-2 max-h-[160px] overflow-auto">
                    {result.system_logs.slice(-5).map((log, i) => (
                      <div key={i} className="text-[10px] font-medium text-slate-500 border-l-2 border-slate-200 pl-3 py-1">{log}</div>
                    ))}
                  </div>
                </div>
              </div>
            </div>
          )}

          {result && activeTab === 'network' && (
            <div className="flex flex-col h-full space-y-4">
              <div className="flex justify-between items-center">
                <select value={selectedItem} onChange={(e) => setSelectedItem(e.target.value)} className="bg-white border border-slate-200 rounded px-4 py-2 text-xs font-bold min-w-[300px]">
                  {result.raw_data.items.map(item => <option key={item.ItemID} value={item.ItemID}>{item.ItemID}</option>)}
                </select>
                <div className="flex gap-4"><div className="flex items-center gap-2"><div className="w-0 h-0 border-l-[6px] border-l-transparent border-r-[6px] border-r-transparent border-b-[10px] border-b-indigo-600"></div><span className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter">Materials</span></div><div className="flex items-center gap-2"><div className="w-3 h-3 rounded-full bg-amber-400"></div><span className="text-[10px] font-bold text-slate-400 uppercase tracking-tighter">Activity</span></div></div>
              </div>
              <div className="flex-1 bg-white rounded-2xl border border-slate-200 shadow-inner overflow-hidden relative min-h-[500px]"><ReactFlow nodes={nodes} edges={edges} nodeTypes={nodeTypes} fitView><Background color="#f1f5f9" gap={20} /><Controls /></ReactFlow></div>
            </div>
          )}

          {result && activeTab === 'plan' && (
            <div className="space-y-4">
              <div className="flex items-center justify-between"><div className="flex items-center gap-2"><Factory size={16} className="text-indigo-600"/><h3 className="text-[10px] font-black text-slate-800 uppercase tracking-widest">Global Production Plan</h3></div><button onClick={handleExportProduction} className="flex items-center gap-2 bg-slate-800 hover:bg-black text-white px-3 py-1.5 rounded text-[10px] font-bold transition-all shadow-md"><Download size={12}/> EXPORT EXCEL</button></div>
              <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                <table className="w-full text-left text-xs">
                  <thead className="bg-slate-50 border-b border-slate-200 font-black text-slate-400 uppercase tracking-tighter"><tr><th className="px-6 py-4">Order ID</th><th className="px-6 py-4">Item</th><th className="px-6 py-4">Supplier/Resource</th><th className="px-6 py-4 text-right">Qty</th><th className="px-6 py-4">Start</th><th className="px-6 py-4">Finish</th></tr></thead>
                  <tbody className="divide-y divide-slate-100">{result.planned_orders?.filter(o => o.type === 'Production').map((o, i) => (<tr key={i} className="hover:bg-slate-50 transition-colors"><td className="px-6 py-3 font-mono text-indigo-600">{o.id}</td><td className="px-6 py-3 font-bold">{o.item}</td><td className="px-6 py-3 text-slate-500 font-medium">{o.res || 'Internal'}</td><td className="px-6 py-3 text-right">{formatNum(o.qty)}</td><td className="px-6 py-3 text-slate-400">{o.start}</td><td className="px-6 py-3 text-slate-400">{o.finish}</td></tr>))}</tbody>
                </table>
              </div>
            </div>
          )}

          {result && activeTab === 'mrp' && (
            <div className="space-y-12 pb-20">
              <div className="space-y-6">
                <select value={selectedItem} onChange={(e) => setSelectedItem(e.target.value)} className="bg-white border border-slate-200 rounded px-4 py-2 text-xs font-bold min-w-[300px]">{Object.keys(result.mrp).map(id => <option key={id} value={id}>{id}</option>)}</select>
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-x-auto">
                  <table className="w-full text-left text-[10px] border-collapse">
                    <thead className="bg-slate-50 border-b border-slate-200"><tr><th className="px-4 py-3 sticky left-0 bg-slate-50 z-20 border-r border-slate-200 min-w-[150px]">Bucket</th>{Object.keys(result.mrp[selectedItem]).map(d => <th key={d} className="px-4 py-3 min-w-[100px] text-slate-400 font-medium">{d}</th>)}</tr></thead>
                    <tbody className="divide-y divide-slate-100">
                      <tr className="bg-slate-50/50"><td className="px-4 py-2 font-black uppercase tracking-tighter sticky left-0 bg-white z-10 border-r border-slate-200 text-slate-600">Starting Stock</td>{Object.values(result.mrp[selectedItem]).map((b, i) => <td key={i} className="px-4 py-2 text-right text-slate-500">{formatNum((b.starting_stock || 0) + (b.inflow_onhand || 0))}</td>)}</tr>
                      <tr onClick={() => setExpandInflow(!expandInflow)} className="cursor-pointer hover:bg-slate-50"><td className="px-4 py-2 font-black uppercase tracking-tighter sticky left-0 bg-white z-10 border-r border-slate-200 text-indigo-600 flex items-center gap-2">{expandInflow ? <ChevronDown size={10}/> : <ChevronRight size={10}/>} Inflow</td>{Object.values(result.mrp[selectedItem]).map((b, i) => <td key={i} className="px-4 py-2 text-right font-bold text-indigo-600">{formatNum((b.inflow_wip || 0) + (b.inflow_supplier || 0) + (b.inflow_fresh || 0))}</td>)}</tr>
                      {expandInflow && (<><tr className="bg-indigo-50/30"><td className="px-4 py-1 text-slate-400 font-medium sticky left-0 bg-white border-r border-slate-200 pl-8">↳ WIP</td>{Object.values(result.mrp[selectedItem]).map((b, i) => <td key={i} className="px-4 py-1 text-right text-slate-400">{formatNum(b.inflow_wip)}</td>)}</tr><tr className="bg-indigo-50/30"><td className="px-4 py-1 text-slate-400 font-medium sticky left-0 bg-white border-r border-slate-200 pl-8">↳ Supplier Stock</td>{Object.values(result.mrp[selectedItem]).map((b, i) => <td key={i} className="px-4 py-1 text-right text-slate-400">{formatNum(b.inflow_supplier)}</td>)}</tr><tr className="bg-indigo-50/30"><td className="px-4 py-1 text-indigo-500 font-medium sticky left-0 bg-white border-r border-slate-200 pl-8">↳ Fresh Plan</td>{Object.values(result.mrp[selectedItem]).map((b, i) => <td key={i} className="px-4 py-1 text-right text-indigo-500 font-bold">{formatNum(b.inflow_fresh)}</td>)}</tr></>)}
                      <tr onClick={() => setExpandOutflow(!expandOutflow)} className="cursor-pointer hover:bg-slate-50"><td className="px-4 py-2 font-black uppercase tracking-tighter sticky left-0 bg-white z-10 border-r border-slate-200 text-amber-600 flex items-center gap-2">{expandOutflow ? <ChevronDown size={10}/> : <ChevronRight size={10}/>} Outflow</td>{Object.values(result.mrp[selectedItem]).map((b, i) => <td key={i} className="px-4 py-2 text-right font-bold text-amber-600">{formatNum((b.outflow_direct || 0) + (b.outflow_dep || 0))}</td>)}</tr>
                      {expandOutflow && (<><tr className="bg-amber-50/30"><td className="px-4 py-1 text-slate-400 font-medium sticky left-0 bg-white border-r border-slate-200 pl-8">↳ Direct Demand</td>{Object.values(result.mrp[selectedItem]).map((b, i) => <td key={i} className="px-4 py-1 text-right text-slate-400">{formatNum(b.outflow_direct)}</td>)}</tr><tr className="bg-amber-50/30"><td className="px-4 py-1 text-slate-400 font-medium sticky left-0 bg-white border-r border-slate-200 pl-8">↳ Dependent Demand</td>{Object.values(result.mrp[selectedItem]).map((b, i) => <td key={i} className="px-4 py-1 text-right text-slate-400">{formatNum(b.outflow_dep)}</td>)}</tr></>)}
                      <tr className="bg-slate-100/50 border-t border-slate-200"><td className="px-4 py-2 font-black uppercase tracking-tighter sticky left-0 bg-white z-10 border-r border-slate-200 text-slate-800">Ending Stock</td>{Object.values(result.mrp[selectedItem]).map((bucket, i) => <td key={i} className="px-4 py-2 text-right font-bold text-slate-800">{formatNum(bucket.ending_stock)}</td>)}</tr>
                      <tr><td className="px-4 py-2 font-black uppercase tracking-tighter sticky left-0 bg-white z-10 border-r border-slate-200 text-red-500">Shortage</td>{Object.values(result.mrp[selectedItem]).map((bucket, i) => <td key={i} className={`px-4 py-2 text-right font-bold ${bucket.shortage > 0 ? 'text-red-500 bg-red-50' : 'text-slate-200'}`}>{bucket.shortage > 0 ? formatNum(bucket.shortage) : '-'}</td>)}</tr>
                    </tbody>
                  </table>
                </div>
              </div>
              <div className="space-y-4">
                <div className="flex items-center justify-between"><div className="flex items-center gap-2"><Truck size={16} className="text-indigo-600"/><h3 className="text-[10px] font-black text-slate-800 uppercase tracking-widest">Global Purchase Plan</h3></div><button onClick={handleExportPurchases} className="flex items-center gap-2 bg-slate-800 hover:bg-black text-white px-3 py-1.5 rounded text-[10px] font-bold transition-all shadow-md"><Download size={12}/> EXPORT EXCEL</button></div>
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <table className="w-full text-left text-[10px]">
                    <thead className="bg-slate-50 border-b border-slate-200 font-black text-slate-400 uppercase tracking-tighter"><tr><th className="px-6 py-4">Purchase Date</th><th className="px-6 py-4">Arrival Date</th><th className="px-6 py-4">Supplier</th><th className="px-6 py-4">Item</th><th className="px-6 py-4 text-right">Qty</th></tr></thead>
                    <tbody className="divide-y divide-slate-100">{result.planned_orders?.filter(o => o.type === 'Purchase').map((o, i) => (<tr key={i} className="hover:bg-indigo-50/30 transition-colors"><td className="px-6 py-3 text-slate-600 font-medium">{o.start}</td><td className="px-6 py-3 text-slate-400">{o.finish}</td><td className="px-6 py-3 font-bold text-slate-800">{o.supplier}</td><td className="px-6 py-3 font-mono text-indigo-600">{o.item}</td><td className="px-6 py-3 text-right font-black">{formatNum(o.qty)}</td></tr>))}</tbody>
                  </table>
                </div>
              </div>
            </div>
          )}

          {result && activeTab === 'rca' && (
            <div className="grid grid-cols-4 gap-8 h-[600px]">
              <div className="col-span-1 space-y-2 overflow-auto pr-4 border-r border-slate-200"><h4 className="text-[10px] font-black text-slate-400 uppercase mb-4">Demand Orders</h4>{result.trace?.map(t => (<div key={t.order_id} onClick={() => setSelectedTrace(t)} className={`p-3 rounded border transition-all cursor-pointer ${selectedTrace?.order_id === t.order_id ? 'border-indigo-600 bg-indigo-50' : 'border-slate-200 bg-white'}`}><div className="text-[9px] font-bold text-slate-400">{t.order_id}</div><div className="text-xs font-bold">{t.item}</div></div>))}</div>
              <div className="col-span-3 space-y-6 overflow-auto"><div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm"><h4 className="text-xs font-bold mb-4">Decision Trace for {selectedTrace?.item}</h4>{selectedTrace?.steps?.map((s, i) => (<div key={i} className="mb-4 pl-4 border-l-2 border-indigo-100 flex gap-4 items-start animate-in fade-in duration-300"><span className={`px-2 py-0.5 rounded-[4px] text-[9px] font-black uppercase whitespace-nowrap ${s.action === 'Infeasible' ? 'bg-red-50 text-red-600' : s.action === 'Production' ? 'bg-indigo-50 text-indigo-600' : s.action === 'Purchase' ? 'bg-emerald-50 text-emerald-600' : 'bg-slate-100 text-slate-600'}`}>{s.action}</span><div><p className="text-xs font-bold text-slate-700">{s.reason || s.msg || 'Resolved'}</p></div></div>))}</div></div>
            </div>
          )}

          {!result && activeTab !== 'data' && (
             <div className="flex flex-col items-center justify-center h-full text-center">
                <Database size={48} className="text-slate-200 mb-4" /><h3 className="font-bold text-slate-700">No Data Available</h3><p className="text-xs text-slate-400 mb-6">Please upload and run the solver in the Data Management tab.</p><button onClick={() => setActiveTab('data')} className="bg-indigo-600 text-white px-6 py-2 rounded text-xs font-bold">Go to Data Management</button>
             </div>
          )}
        </div>
      </main>
    </div>
  );
}

const NavItem = ({ icon, label, active, onClick, disabled }) => (
  <div onClick={!disabled ? onClick : undefined} className={`flex items-center gap-3 px-4 py-2.5 rounded cursor-pointer transition-all ${disabled ? 'opacity-30 cursor-not-allowed' : (active ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-400 hover:bg-slate-800')}`}>{icon} <span className="text-xs font-bold uppercase tracking-tight">{label}</span></div>
);

const KPICard = ({ label, value, icon, trend }) => (
  <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm transition-all hover:border-indigo-200">
    <div className="flex justify-between items-start mb-3"><div className="p-2 bg-slate-50 rounded shadow-inner">{icon}</div>{trend && <span className={`text-[9px] font-black px-1.5 py-0.5 rounded ${trend === 'Healthy' ? 'bg-green-50 text-green-600' : 'bg-amber-50 text-amber-600'}`}>{trend}</span>}</div>
    <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">{label}</p><h4 className="text-xl font-black text-slate-800 tabular-nums">{value}</h4>
  </div>
);