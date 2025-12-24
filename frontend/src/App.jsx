import React, { useState, useMemo } from 'react';
import axios from 'axios';
import { 
  LayoutDashboard, Database, Play, Box, Truck, BarChart3, 
  UploadCloud, FileText, Loader2, Search, ClipboardList, AlertCircle,
  Settings, ChevronRight, ChevronDown
} from 'lucide-react';
import { BarChart, Bar, XAxis, YAxis, Tooltip, ResponsiveContainer, CartesianGrid, Legend } from 'recharts';

export default function App() {
  const [files, setFiles] = useState([]);
  const [loading, setLoading] = useState(false);
  const [result, setResult] = useState(null);
  const [activeTab, setActiveTab] = useState('executive'); 
  const [selectedItem, setSelectedItem] = useState('');
  const [selectedTrace, setSelectedTrace] = useState(null);
  
  // --- PARAMETERS STATE ---
  const [isConstrained, setIsConstrained] = useState(true);
  const [buildAhead, setBuildAhead] = useState(true);

  // --- MRP EXPANSION STATES ---
  const [expandInflow, setExpandInflow] = useState(false);
  const [expandOutflow, setExpandOutflow] = useState(false);

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
      if (response.data.mrp) setSelectedItem(Object.keys(response.data.mrp)[0]);
      if (response.data.trace) setSelectedTrace(response.data.trace[0]);
    } catch (error) {
      console.error("Solver Error:", error);
    } finally {
      setLoading(false);
    }
  };

  const chartData = useMemo(() => {
    if (!result?.planned_orders) return [];
    const grouped = result.planned_orders.reduce((acc, curr) => {
      const date = curr.start;
      if (!acc[date]) acc[date] = { date, Production: 0, Purchase: 0 };
      acc[date][curr.type] = (acc[date][curr.type] || 0) + curr.qty;
      return acc;
    }, {});
    return Object.values(grouped).sort((a, b) => new Date(a.date) - new Date(b.date));
  }, [result]);

  return (
    <div className="flex h-screen bg-[#F8FAFC] text-slate-900 font-sans overflow-hidden">
      {/* SIDEBAR */}
      <aside className="w-64 bg-[#0F172A] text-white flex flex-col shadow-2xl">
        <div className="p-6 border-b border-slate-700 bg-[#1E293B]">
          <div className="flex items-center gap-3">
            <div className="w-8 h-8 bg-indigo-500 rounded flex items-center justify-center"><Box size={20} /></div>
            <span className="font-bold text-sm tracking-widest uppercase">Upstrail APS</span>
          </div>
        </div>
        
        <nav className="flex-1 p-4 space-y-1 mt-4 overflow-y-auto">
          <NavItem icon={<LayoutDashboard size={18}/>} label="Executive Summary" active={activeTab === 'executive'} onClick={() => setActiveTab('executive')} />
          <NavItem icon={<ClipboardList size={18}/>} label="MRP Inventory Plan" active={activeTab === 'mrp'} onClick={() => setActiveTab('mrp')} />
          <NavItem icon={<Truck size={18}/>} label="Production Plan" active={activeTab === 'plan'} onClick={() => setActiveTab('plan')} />
          <NavItem icon={<Search size={18}/>} label="Trace RCA" active={activeTab === 'rca'} onClick={() => setActiveTab('rca')} />
        </nav>

        {/* PARAMETERS SECTION */}
        <div className="p-4 bg-[#1E293B] border-t border-slate-700">
          <div className="flex items-center gap-2 mb-4 text-slate-400">
            <Settings size={14} />
            <span className="text-[10px] font-bold uppercase tracking-widest">Solver Parameters</span>
          </div>
          <div className="space-y-4">
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-300">Capacity Constrained</span>
              <button 
                onClick={() => setIsConstrained(!isConstrained)}
                className={`w-8 h-4 rounded-full transition-colors relative ${isConstrained ? 'bg-indigo-500' : 'bg-slate-600'}`}
              >
                <div className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform ${isConstrained ? 'translate-x-4' : 'translate-x-0'}`} />
              </button>
            </div>
            <div className="flex items-center justify-between">
              <span className="text-xs font-medium text-slate-300">Build Ahead</span>
              <button 
                onClick={() => setBuildAhead(!buildAhead)}
                className={`w-8 h-4 rounded-full transition-colors relative ${buildAhead ? 'bg-indigo-500' : 'bg-slate-600'}`}
              >
                <div className={`absolute top-0.5 left-0.5 w-3 h-3 bg-white rounded-full transition-transform ${buildAhead ? 'translate-x-4' : 'translate-x-0'}`} />
              </button>
            </div>
          </div>
        </div>
      </aside>

      {/* MAIN CONTENT */}
      <main className="flex-1 flex flex-col overflow-hidden">
        <header className="h-14 bg-white border-b border-slate-200 flex items-center justify-between px-8 shadow-sm z-10">
          <h2 className="text-[10px] font-black text-slate-400 uppercase tracking-[0.2em]">Workspace / {activeTab}</h2>
          <button 
            onClick={handleSolve}
            disabled={loading || files.length === 0}
            className="flex items-center gap-2 bg-indigo-600 hover:bg-indigo-700 text-white px-4 py-1.5 rounded text-xs font-bold transition-all disabled:opacity-30 shadow-lg shadow-indigo-100"
          >
            {loading ? <Loader2 className="animate-spin" size={14}/> : <Play size={14}/>}
            {loading ? "PROCESSING..." : "RUN SOLVER"}
          </button>
        </header>

        <div className="flex-1 overflow-auto p-8">
          <div className="grid grid-cols-4 gap-6 mb-8">
            <KPICard label="Planned Orders" value={result?.summary?.total_planned_orders || 0} icon={<FileText className="text-blue-500"/>} />
            <KPICard label="Inventory Health" value="92%" icon={<BarChart3 className="text-green-500"/>} trend="+1.2%" />
            <KPICard label="Shortages" value={result?.summary?.shortage_count || 0} icon={<AlertCircle className={result?.summary?.shortage_count > 0 ? "text-red-500" : "text-slate-300"}/>} />
            <KPICard label="Active Items" value={Object.keys(result?.mrp || {}).length} icon={<Box className="text-indigo-500"/>} />
          </div>

          {!result ? (
            <div className="bg-white rounded-xl border-2 border-dashed border-slate-200 p-20 text-center flex flex-col items-center justify-center">
              <UploadCloud size={48} className="text-slate-200 mb-4" />
              <h3 className="font-bold text-slate-700 mb-6">Upload Master Data</h3>
              <input type="file" multiple onChange={(e) => setFiles(Array.from(e.target.files))} className="hidden" id="f-up" />
              <label htmlFor="f-up" className="bg-indigo-600 text-white px-8 py-2 rounded font-bold text-xs cursor-pointer shadow-xl shadow-indigo-100">Browse Files</label>
              <div className="mt-6 flex flex-wrap justify-center gap-2 max-w-md">
                {files.map(f => <span key={f.name} className="text-[9px] bg-indigo-50 text-indigo-600 px-2 py-1 rounded font-bold">✓ {f.name}</span>)}
              </div>
            </div>
          ) : (
            <div className="space-y-8 animate-in fade-in slide-in-from-bottom-2 duration-500">
              
              {activeTab === 'executive' && (
                <div className="bg-white p-8 rounded-xl border border-slate-200 shadow-sm h-[450px]">
                  <h3 className="text-[10px] font-black text-slate-400 uppercase tracking-widest mb-8">Supply Inflow Horizon</h3>
                  <ResponsiveContainer width="100%" height="90%">
                    <BarChart data={chartData}>
                      <CartesianGrid strokeDasharray="3 3" vertical={false} stroke="#f1f5f9" />
                      <XAxis dataKey="date" fontSize={9} axisLine={false} tickLine={false} tick={{fill: '#94a3b8'}} />
                      <YAxis fontSize={9} axisLine={false} tickLine={false} tick={{fill: '#94a3b8'}} />
                      <Tooltip cursor={{fill: '#f8fafc'}} contentStyle={{ borderRadius: '8px', border: 'none', boxShadow: '0 10px 15px -3px rgba(0,0,0,0.1)' }} />
                      <Bar dataKey="Production" fill="#6366f1" radius={[2, 2, 0, 0]} barSize={24} />
                      <Bar dataKey="Purchase" fill="#cbd5e1" radius={[2, 2, 0, 0]} barSize={24} />
                    </BarChart>
                  </ResponsiveContainer>
                </div>
              )}

              {activeTab === 'plan' && (
                <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-hidden">
                  <table className="w-full text-left text-xs">
                    <thead className="bg-slate-50 border-b border-slate-200 font-black text-slate-400 uppercase tracking-tighter">
                      <tr>
                        <th className="px-6 py-4">Order ID</th>
                        <th className="px-6 py-4">Item</th>
                        <th className="px-6 py-4">Supplier/Resource</th>
                        <th className="px-6 py-4 text-right">Qty</th>
                        <th className="px-6 py-4">Start</th>
                        <th className="px-6 py-4">Finish</th>
                        <th className="px-6 py-4 text-right">LT (Days)</th>
                      </tr>
                    </thead>
                    <tbody className="divide-y divide-slate-100">
                      {result.planned_orders?.filter(o => o.type === 'Production').map((o, i) => (
                        <tr key={i} className="hover:bg-slate-50 transition-colors">
                          <td className="px-6 py-3 font-mono text-indigo-600">{o.id}</td>
                          <td className="px-6 py-3 font-bold">{o.item}</td>
                          <td className="px-6 py-3 text-slate-500 font-medium">{o.res || 'Internal'}</td>
                          <td className="px-6 py-3 text-right">{o.qty}</td>
                          <td className="px-6 py-3 text-slate-400">{o.start}</td>
                          <td className="px-6 py-3 text-slate-400">{o.finish}</td>
                          <td className="px-6 py-3 text-right text-slate-400">{o.lt_days}</td>
                        </tr>
                      ))}
                    </tbody>
                  </table>
                </div>
              )}

              {activeTab === 'mrp' && (
                <div className="space-y-6">
                  <select value={selectedItem} onChange={(e) => setSelectedItem(e.target.value)} className="bg-white border border-slate-200 rounded px-4 py-2 text-xs font-bold outline-none shadow-sm min-w-[300px]">
                    {Object.keys(result.mrp).map(id => <option key={id} value={id}>{id}</option>)}
                  </select>
                  
                  <div className="bg-white rounded-xl border border-slate-200 shadow-sm overflow-x-auto">
                    <table className="w-full text-left text-[10px] border-collapse">
                      <thead className="bg-slate-50 border-b border-slate-200">
                        <tr>
                          <th className="px-4 py-3 sticky left-0 bg-slate-50 z-20 border-r border-slate-200 min-w-[150px]">Bucket</th>
                          {Object.keys(result.mrp[selectedItem]).map(d => <th key={d} className="px-4 py-3 min-w-[100px] text-slate-400 font-medium">{d}</th>)}
                        </tr>
                      </thead>
                      <tbody className="divide-y divide-slate-100">
                        {/* 1. STARTING STOCK (Including OnHand) */}
                        <tr className="bg-slate-50/50">
                           <td className="px-4 py-2 font-black uppercase tracking-tighter sticky left-0 bg-white z-10 border-r border-slate-200 text-slate-600">Starting Stock</td>
                           {Object.values(result.mrp[selectedItem]).map((b, i) => (
                             <td key={i} className="px-4 py-2 text-right text-slate-500">
                               {/* Add Starting Stock + Inflow OnHand visually */}
                               {(b.starting_stock || 0) + (b.inflow_onhand || 0)}
                             </td>
                           ))}
                        </tr>

                        {/* 2. INFLOW (Clickable Group) */}
                        <tr onClick={() => setExpandInflow(!expandInflow)} className="cursor-pointer hover:bg-slate-50 transition-colors">
                           <td className="px-4 py-2 font-black uppercase tracking-tighter sticky left-0 bg-white z-10 border-r border-slate-200 text-indigo-600 flex items-center gap-2">
                             {expandInflow ? <ChevronDown size={10}/> : <ChevronRight size={10}/>} Inflow
                           </td>
                           {Object.values(result.mrp[selectedItem]).map((b, i) => (
                             <td key={i} className="px-4 py-2 text-right font-bold text-indigo-600">
                               {(b.inflow_wip || 0) + (b.inflow_supplier || 0) + (b.inflow_fresh || 0)}
                             </td>
                           ))}
                        </tr>
                        
                        {/* 2a. EXPANDED INFLOW ROWS */}
                        {expandInflow && (
                           <>
                              <tr className="bg-indigo-50/30"><td className="px-4 py-1 text-slate-400 font-medium sticky left-0 bg-white border-r border-slate-200 pl-8">↳ WIP</td>{Object.values(result.mrp[selectedItem]).map((b, i) => <td key={i} className="px-4 py-1 text-right text-slate-400">{b.inflow_wip || '-'}</td>)}</tr>
                              <tr className="bg-indigo-50/30"><td className="px-4 py-1 text-slate-400 font-medium sticky left-0 bg-white border-r border-slate-200 pl-8">↳ Supplier Stock</td>{Object.values(result.mrp[selectedItem]).map((b, i) => <td key={i} className="px-4 py-1 text-right text-slate-400">{b.inflow_supplier || '-'}</td>)}</tr>
                              <tr className="bg-indigo-50/30"><td className="px-4 py-1 text-indigo-500 font-medium sticky left-0 bg-white border-r border-slate-200 pl-8">↳ Fresh Plan</td>{Object.values(result.mrp[selectedItem]).map((b, i) => <td key={i} className="px-4 py-1 text-right text-indigo-500 font-bold">{b.inflow_fresh || '-'}</td>)}</tr>
                           </>
                        )}

                        {/* 3. OUTFLOW (Clickable Group) */}
                        <tr onClick={() => setExpandOutflow(!expandOutflow)} className="cursor-pointer hover:bg-slate-50 transition-colors">
                           <td className="px-4 py-2 font-black uppercase tracking-tighter sticky left-0 bg-white z-10 border-r border-slate-200 text-amber-600 flex items-center gap-2">
                             {expandOutflow ? <ChevronDown size={10}/> : <ChevronRight size={10}/>} Outflow
                           </td>
                           {Object.values(result.mrp[selectedItem]).map((b, i) => (
                             <td key={i} className="px-4 py-2 text-right font-bold text-amber-600">
                               {(b.outflow_direct || 0) + (b.outflow_dep || 0)}
                             </td>
                           ))}
                        </tr>

                        {/* 3a. EXPANDED OUTFLOW ROWS */}
                        {expandOutflow && (
                           <>
                              <tr className="bg-amber-50/30"><td className="px-4 py-1 text-slate-400 font-medium sticky left-0 bg-white border-r border-slate-200 pl-8">↳ Direct Demand</td>{Object.values(result.mrp[selectedItem]).map((b, i) => <td key={i} className="px-4 py-1 text-right text-slate-400">{b.outflow_direct || '-'}</td>)}</tr>
                              <tr className="bg-amber-50/30"><td className="px-4 py-1 text-slate-400 font-medium sticky left-0 bg-white border-r border-slate-200 pl-8">↳ Dependent Demand</td>{Object.values(result.mrp[selectedItem]).map((b, i) => <td key={i} className="px-4 py-1 text-right text-slate-400">{b.outflow_dep || '-'}</td>)}</tr>
                           </>
                        )}

                        {/* 4. ENDING STOCK */}
                        <tr className="bg-slate-100/50 border-t border-slate-200">
                           <td className="px-4 py-2 font-black uppercase tracking-tighter sticky left-0 bg-white z-10 border-r border-slate-200 text-slate-800">Ending Stock</td>
                           {Object.values(result.mrp[selectedItem]).map((bucket, i) => <td key={i} className="px-4 py-2 text-right font-bold text-slate-800">{bucket.ending_stock}</td>)}
                        </tr>

                        {/* 5. SHORTAGE */}
                         <tr>
                           <td className="px-4 py-2 font-black uppercase tracking-tighter sticky left-0 bg-white z-10 border-r border-slate-200 text-red-500">Shortage</td>
                           {Object.values(result.mrp[selectedItem]).map((bucket, i) => <td key={i} className={`px-4 py-2 text-right font-bold ${bucket.shortage > 0 ? 'text-red-500 bg-red-50' : 'text-slate-200'}`}>{bucket.shortage > 0 ? bucket.shortage : '-'}</td>)}
                        </tr>
                      </tbody>
                    </table>
                  </div>

                  <div className="bg-white rounded-xl border border-slate-200 shadow-sm p-4">
                     <h4 className="text-xs font-bold uppercase text-slate-400 mb-4">Purchasing Requirements for {selectedItem}</h4>
                     {result.planned_orders.filter(o => o.type === 'Purchase' && o.item === selectedItem).length === 0 ? (
                        <p className="text-xs text-slate-400 italic">No purchase orders generated for this item.</p>
                     ) : (
                        <table className="w-full text-left text-xs">
                           <thead className="bg-slate-50 text-slate-500">
                              <tr><th className="p-2">Supplier</th><th className="p-2 text-right">Qty</th><th className="p-2">Release</th><th className="p-2">Receipt</th></tr>
                           </thead>
                           <tbody>
                              {result.planned_orders.filter(o => o.type === 'Purchase' && o.item === selectedItem).map((po, idx) => (
                                 <tr key={idx} className="border-b border-slate-100">
                                    <td className="p-2 font-bold text-indigo-600">{po.supplier}</td>
                                    <td className="p-2 text-right">{po.qty}</td>
                                    <td className="p-2 text-slate-400">{po.start}</td>
                                    <td className="p-2 text-slate-400">{po.finish}</td>
                                 </tr>
                              ))}
                           </tbody>
                        </table>
                     )}
                  </div>
                </div>
              )}

              {activeTab === 'rca' && (
                <div className="grid grid-cols-4 gap-8 h-[600px]">
                  <div className="col-span-1 space-y-2 overflow-auto pr-4 border-r border-slate-200">
                    <h4 className="text-[10px] font-black text-slate-400 uppercase mb-4">Demand Orders</h4>
                    {result.trace?.map(t => (
                      <div key={t.order_id} onClick={() => setSelectedTrace(t)} className={`p-3 rounded border transition-all cursor-pointer ${selectedTrace?.order_id === t.order_id ? 'border-indigo-600 bg-indigo-50' : 'border-slate-200 bg-white'}`}>
                        <div className="text-[9px] font-bold text-slate-400">{t.order_id}</div>
                        <div className="text-xs font-bold">{t.item}</div>
                      </div>
                    ))}
                  </div>
                  <div className="col-span-3 space-y-6 overflow-auto">
                    <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm">
                      <h4 className="text-xs font-bold mb-4">Decision Trace for {selectedTrace?.item}</h4>
                      {selectedTrace?.steps?.map((s, i) => (
                        <div key={i} className="mb-4 pl-4 border-l-2 border-indigo-100 flex gap-4 items-start animate-in fade-in duration-300">
                          <span className={`
                             px-2 py-0.5 rounded-[4px] text-[9px] font-black uppercase whitespace-nowrap
                             ${s.action === 'Infeasible' ? 'bg-red-50 text-red-600' : 
                               s.action === 'Production' ? 'bg-indigo-50 text-indigo-600' :
                               s.action === 'Purchase' ? 'bg-emerald-50 text-emerald-600' :
                               'bg-slate-100 text-slate-600'}
                          `}>{s.action}</span>
                          <div>
                            <p className="text-xs font-bold text-slate-700">{s.reason || s.msg || 'Resolved'}</p>
                            <div className="flex gap-4 mt-1">
                               {s.item && <span className="text-[10px] text-slate-400 font-mono">ITEM: {s.item}</span>}
                               {s.date && <span className="text-[10px] text-slate-400 font-mono">DUE: {s.date}</span>}
                               {s.supplier && <span className="text-[10px] text-slate-400 font-mono">SUP: {s.supplier}</span>}
                               {s.resource && <span className="text-[10px] text-slate-400 font-mono">RES: {s.resource}</span>}
                            </div>
                          </div>
                        </div>
                      ))}
                    </div>
                  </div>
                </div>
              )}
            </div>
          )}
        </div>
      </main>

      {/* DEBUG PANEL */}
      {result && (
        <div className="fixed bottom-6 right-6 w-80 max-h-[400px] bg-slate-900 text-indigo-400 p-5 rounded-2xl shadow-2xl border border-indigo-500/30 overflow-auto z-50 font-mono text-[10px]">
          <div className="flex justify-between items-center mb-4 border-b border-slate-800 pb-2">
            <span className="font-bold text-white tracking-widest uppercase text-[9px]">Backend Data Inspector</span>
            <div className="w-2 h-2 rounded-full bg-green-500 animate-pulse"></div>
          </div>
          <div className="space-y-4">
            <div className="grid grid-cols-2 gap-2 text-white bg-slate-800/50 p-2 rounded">
              <div>Orders: <span className="text-indigo-300">{result.planned_orders?.length || 0}</span></div>
              <div>Trace: <span className="text-indigo-300">{result.trace?.length || 0}</span></div>
            </div>
            <div>
              <p className="text-slate-500 uppercase text-[8px] mb-1">Constraints Active?</p>
              <span className={isConstrained ? "text-green-400" : "text-red-400"}>{isConstrained.toString().toUpperCase()}</span>
            </div>
          </div>
        </div>
      )}
    </div>
  );
}

const NavItem = ({ icon, label, active, onClick }) => (
  <div onClick={onClick} className={`flex items-center gap-3 px-4 py-2.5 rounded cursor-pointer transition-all ${active ? 'bg-indigo-600 text-white shadow-lg' : 'text-slate-400 hover:bg-slate-800'}`}>
    {icon} <span className="text-xs font-bold uppercase tracking-tight">{label}</span>
  </div>
);

const KPICard = ({ label, value, icon, trend }) => (
  <div className="bg-white p-6 rounded-xl border border-slate-200 shadow-sm transition-all hover:border-indigo-200">
    <div className="flex justify-between items-start mb-3">
      <div className="p-2 bg-slate-50 rounded shadow-inner">{icon}</div>
      {trend && <span className="text-[9px] text-green-600 font-black bg-green-50 px-1.5 py-0.5 rounded">{trend}</span>}
    </div>
    <p className="text-[9px] font-black text-slate-400 uppercase tracking-widest">{label}</p>
    <h4 className="text-xl font-black text-slate-800 tabular-nums">{value}</h4>
  </div>
);