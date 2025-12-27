import pandas as pd
import numpy as np
from datetime import datetime, timedelta

def normalize_df(df):
    """Standardizes column names and removes empty rows."""
    if df is None: return None
    df_copy = df.copy()
    df_copy.columns = [str(c).lower().replace(" ", "").replace("_", "").replace("-", "") for c in df_copy.columns]
    return df_copy.dropna(how='all').reset_index(drop=True)

def get_col(df, *options):
    """Finds a column name in a dataframe based on multiple possible matches."""
    if df is None: return None
    norm_options = [o.lower().replace(" ", "").replace("_", "").replace("-", "") for o in options]
    for col in df.columns:
        normalized_col = str(col).lower().replace(" ", "").replace("_", "").replace("-", "")
        if normalized_col in norm_options:
            return col
    return None

def apply_lot_sizing(qty, lot_size, lot_inc):
    """Applies lot size and increment logic to a requirement."""
    if lot_size <= 0:
        return qty
    if qty <= lot_size:
        return lot_size
    if lot_inc > 0:
        extra = qty - lot_size
        num_increments = np.ceil(extra / lot_inc)
        return lot_size + (num_increments * lot_inc)
    return qty

def run_solver(data, horizon, start_date, is_constrained, build_ahead):
    """
    Engine to calculate MRP with Supplier Lot Sizing and Increment logic.
    """
    is_constrained = str(is_constrained).lower() == 'true'
    build_ahead = str(build_ahead).lower() == 'true'

    system_logs = []
    def sys_log(msg):
        system_logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")

    sys_log(f"Initializing Solver Engine (Lot-Sizing Enabled)")
    
    # 1. Normalize Data
    items = normalize_df(data.get('items'))
    demand = normalize_df(data.get('demand'))
    bom = normalize_df(data.get('bom'))
    routing_master = normalize_df(data.get('routing'))
    res_routing = normalize_df(data.get('resource_routing'))
    supplies = normalize_df(data.get('supplies'))
    supplier_master = normalize_df(data.get('supplier_master'))
    
    # Standardize IDs
    for df in [items, bom, routing_master, res_routing, supplies, supplier_master, demand]:
        if df is not None:
            for col in df.columns:
                if any(x in col for x in ['id', 'item', 'child', 'parent', 'resource']):
                    df[col] = df[col].astype(str).str.strip().str.upper()

    transient_stock = {}
    initial_onhand, initial_wip, initial_supplier_stock = {}, {}, {}
    
    # 2. Initialize Inventory
    item_col = get_col(supplies, "itemid", "itemcode", "item")
    if item_col and supplies is not None:
        for _, row in supplies.iterrows():
            item_id = str(row[item_col])
            oh = pd.to_numeric(row.get('fg', 0), errors='coerce') or 0
            wp = pd.to_numeric(row.get('wip', 0), errors='coerce') or 0
            sup = pd.to_numeric(row.get('supplier', 0), errors='coerce') or 0
            other = sum([pd.to_numeric(row[c], errors='coerce') or 0 for c in supplies.columns if 'rework' in str(c).lower()])
            
            initial_onhand[item_id] = oh + other
            initial_wip[item_id] = wp
            initial_supplier_stock[item_id] = sup
            transient_stock[item_id] = initial_onhand[item_id] + initial_wip[item_id] + initial_supplier_stock[item_id]
    
    # 3. Initialize Capacities
    dates_list = [(start_date + timedelta(days=i)).strftime('%Y-%m-%d') for i in range(horizon + 61)]
    
    transient_resource_capacity = {}
    if res_routing is not None:
        for _, row in res_routing.iterrows():
            res_id = str(row['resourceid'])
            if res_id not in transient_resource_capacity:
                daily_hours = (pd.to_numeric(row.get('dailycapacity', 0)) or 0) * (pd.to_numeric(row.get('noofmachines', 1)) or 1)
                transient_resource_capacity[res_id] = {d: daily_hours for d in dates_list}

    transient_supplier_capacity = {}
    if supplier_master is not None:
        for _, row in supplier_master.iterrows():
            s_id = str(row.get('supplierid', row.get('suppliername', 'Unknown')))
            item_id = str(row['itemid'])
            cap_key = f"{s_id}_{item_id}"
            if cap_key not in transient_supplier_capacity:
                daily_qty = pd.to_numeric(row.get('suppliercapacityperday', 999999), errors='coerce') or 999999
                transient_supplier_capacity[cap_key] = {d: daily_qty for d in dates_list}

    # 4. Sort Demand
    if demand is not None:
        demand['priority'] = pd.to_numeric(demand.get('demandpriority', 999), errors='coerce')
        demand['date_dt'] = pd.to_datetime(demand['duedate'])
        demand['duedate_clean'] = demand['date_dt'].dt.strftime('%Y-%m-%d')
        sorted_demand = demand.sort_values(by=['priority', 'date_dt'])
    else:
        sorted_demand = pd.DataFrame()

    planned_orders, demand_trace, mrp_plan = [], [], {} 

    def init_mrp(item_id):
        if item_id not in mrp_plan:
            mrp_plan[item_id] = {d: {
                'starting_stock': 0, 'inflow_supplier': 0, 'inflow_wip': 0, 
                'inflow_onhand': 0, 'inflow_fresh': 0, 'outflow_dep': 0, 
                'outflow_direct': 0, 'ending_stock': 0, 'shortage': 0
            } for d in dates_list[:horizon+1]}
            first_date = dates_list[0]
            mrp_plan[item_id][first_date]['inflow_onhand'] = initial_onhand.get(item_id, 0)
            mrp_plan[item_id][first_date]['inflow_wip'] = initial_wip.get(item_id, 0)
            mrp_plan[item_id][first_date]['inflow_supplier'] = initial_supplier_stock.get(item_id, 0)

    def resolve(item_id, qty, due_date_str, steps, log_list, is_direct=False, depth=0):
        item_id = item_id.strip().upper()
        init_mrp(item_id)
        if due_date_str in mrp_plan[item_id]:
            if is_direct: mrp_plan[item_id][due_date_str]['outflow_direct'] += qty
            else: mrp_plan[item_id][due_date_str]['outflow_dep'] += qty
        
        item_info = items[items['itemid'] == item_id] if items is not None else pd.DataFrame()
        if item_info.empty:
            steps.append({"action": "Infeasible", "reason": "Missing Master Data", "item": item_id})
            return qty
        
        item_row = item_info.iloc[0]
        unmet = qty
        
        # Stock Consumption
        stock = transient_stock.get(item_id, 0)
        if stock > 0:
            consumed = min(unmet, stock)
            transient_stock[item_id] -= consumed
            unmet -= consumed
            steps.append({"action": "Stock", "msg": f"Consumed {round(consumed, 4)} units", "qty": round(consumed, 4), "item": item_id})
        
        if unmet <= 0: return 0

        mb_raw = str(item_row.get('makebuy', 'buy')).lower()
        is_make = 'make' in mb_raw or 'both' in mb_raw
        
        if is_make:
            # (Production Logic remains the same...)
            base_sec = 0
            if routing_master is not None:
                item_routing = routing_master[routing_master['item'] == item_id]
                if not item_routing.empty:
                    base_sec = pd.to_numeric(item_routing.iloc[0].get('cycletime', 0), errors='coerce') or 0
            if base_sec == 0:
                base_sec = pd.to_numeric(item_row.get('leadtimemakeseconds', item_row.get('leadtimemake', 0)), errors='coerce') or 0

            lt_days = max(0, int((unmet * base_sec) / 86400))
            req_start_dt = datetime.strptime(due_date_str, '%Y-%m-%d') - timedelta(days=lt_days)
            req_start_str = req_start_dt.strftime('%Y-%m-%d')

            if req_start_dt.date() < start_date:
                steps.append({"action": "Infeasible", "reason": "RCA Lead Time Violation", "item": item_id, "needed_start": req_start_str})

            comps = bom[bom['parentid'] == item_id] if bom is not None else pd.DataFrame()
            if not comps.empty:
                for _, c_row in comps.iterrows():
                    c_id = str(c_row['childid'])
                    c_qty = unmet * pd.to_numeric(c_row.get('qtyper', 1))
                    resolve(c_id, c_qty, req_start_str, steps, log_list, False, depth + 1)

            routing = res_routing[res_routing['item'] == item_id] if res_routing is not None else pd.DataFrame()
            if not routing.empty and is_constrained:
                route_row = routing.iloc[0]
                res_id = str(route_row['resourceid'])
                cons_raw = pd.to_numeric(route_row.get('capacityconsumedper', 1))
                needed_cap_hrs = (unmet * cons_raw) / 3600 if cons_raw >= 1 else unmet * cons_raw
                
                found_capacity = False
                max_lookback = 15 if build_ahead else 0
                for lb in range(0, max_lookback + 1):
                    check_dt = req_start_dt - timedelta(days=lb)
                    if check_dt.date() < start_date: break
                    d_str = check_dt.strftime('%Y-%m-%d')
                    avail = transient_resource_capacity.get(res_id, {}).get(d_str, 0)
                    if avail >= needed_cap_hrs:
                        actual_start_dt = check_dt
                        found_capacity = True
                        break
                
                if found_capacity:
                    actual_str = actual_start_dt.strftime('%Y-%m-%d')
                    transient_resource_capacity[res_id][actual_str] -= needed_cap_hrs
                    planned_orders.append({
                        "id": f"PO-{item_id}-{len(planned_orders)}", "item": item_id, "qty": round(unmet, 4), "type": "Production", 
                        "start": actual_str, "finish": due_date_str, "res": res_id, "lt_days": lt_days, "supplier": "Internal"
                    })
                    if due_date_str in mrp_plan[item_id]: mrp_plan[item_id][due_date_str]['inflow_fresh'] += unmet
                    steps.append({"action": "Production", "msg": f"Scheduled on {res_id}", "item": item_id, "qty": round(unmet, 4)})
                    unmet = 0
                else:
                    steps.append({"action": "Infeasible", "reason": "Capacity Bottleneck", "item": item_id, "resource": res_id})
                    if due_date_str in mrp_plan[item_id]: mrp_plan[item_id][due_date_str]['shortage'] += unmet
            else:
                planned_orders.append({"id": f"PO-{item_id}-{len(planned_orders)}", "item": item_id, "qty": round(unmet, 4), "type": "Production", "start": req_start_str, "finish": due_date_str, "lt_days": lt_days, "supplier": "Internal"})
                if due_date_str in mrp_plan[item_id]: mrp_plan[item_id][due_date_str]['inflow_fresh'] += unmet
                steps.append({"action": "Production", "msg": "Scheduled (Unconstrained)", "item": item_id, "qty": round(unmet, 4)})
                unmet = 0
        else:
            # BUY LOGIC WITH LOT SIZING
            item_suppliers = supplier_master[supplier_master['itemid'] == item_id] if supplier_master is not None else pd.DataFrame()
            if item_suppliers.empty:
                # Default logic for items without supplier master
                lt_days = int(pd.to_numeric(item_row.get('leadtimebuy', 7), errors='coerce'))
                req_start_str = (datetime.strptime(due_date_str, '%Y-%m-%d') - timedelta(days=lt_days)).strftime('%Y-%m-%d')
                planned_orders.append({"id": f"PUR-{item_id}-{len(planned_orders)}", "item": item_id, "qty": round(unmet, 4), "type": "Purchase", "start": req_start_str, "finish": due_date_str, "lt_days": lt_days, "supplier": "Unknown"})
                if due_date_str in mrp_plan[item_id]: mrp_plan[item_id][due_date_str]['inflow_fresh'] += unmet
                steps.append({"action": "Purchase", "msg": "Ordered (Default Supplier)", "item": item_id, "qty": round(unmet, 4)})
                unmet = 0
            else:
                sorted_sups = item_suppliers.sort_values(by='sharepercent', ascending=False)
                original_unmet = unmet
                for _, s_row in sorted_sups.iterrows():
                    if unmet <= 0: break
                    
                    # Check for surplus from previous iterations/suppliers
                    surplus_stock = transient_stock.get(item_id, 0)
                    if surplus_stock > 0:
                        consumed = min(unmet, surplus_stock)
                        transient_stock[item_id] -= consumed
                        unmet -= consumed
                        steps.append({"action": "Stock", "msg": f"Used {round(consumed, 4)} surplus", "qty": round(consumed, 4), "item": item_id})
                        if unmet <= 0: break

                    s_id = str(s_row.get('supplierid', s_row.get('suppliername', 'Unknown')))
                    s_name = str(s_row.get('suppliername', s_id))
                    share = pd.to_numeric(s_row.get('sharepercent', 1.0), errors='coerce')
                    lt_days = int(pd.to_numeric(s_row.get('leadtimedays', 7), errors='coerce'))
                    lot_size = pd.to_numeric(s_row.get('supplierlotsize', 0), errors='coerce') or 0
                    lot_inc = pd.to_numeric(s_row.get('supplierlotincrement', 0), errors='coerce') or 0
                    
                    cap_key = f"{s_id}_{item_id}"
                    target_for_sup = original_unmet * share
                    sup_allocated = 0
                    lookback = 15 if build_ahead else 1
                    curr_dt = datetime.strptime(due_date_str, '%Y-%m-%d')
                    
                    for lb in range(lookback):
                        d_str = (curr_dt - timedelta(days=lb)).strftime('%Y-%m-%d')
                        if d_str not in transient_supplier_capacity.get(cap_key, {}): continue
                        
                        avail = transient_supplier_capacity[cap_key][d_str]
                        # Amount needed for this supplier based on share and remaining unmet
                        base_req = min(target_for_sup - sup_allocated, unmet)
                        if base_req <= 0: break

                        # Apply Lot Sizing to the requirement
                        order_qty = apply_lot_sizing(base_req, lot_size, lot_inc)
                        
                        # Cap by available capacity
                        final_qty = min(order_qty, avail)
                        
                        if final_qty > 0:
                            transient_supplier_capacity[cap_key][d_str] -= final_qty
                            
                            # Calculate how much of the final_qty satisfies the current unmet demand
                            satisfied_now = min(final_qty, unmet)
                            # Surplus goes to transient stock for subsequent demands
                            surplus = final_qty - satisfied_now
                            if surplus > 0:
                                transient_stock[item_id] = transient_stock.get(item_id, 0) + surplus
                            
                            p_start = (datetime.strptime(d_str, '%Y-%m-%d') - timedelta(days=lt_days)).strftime('%Y-%m-%d')
                            planned_orders.append({
                                "id": f"PUR-{item_id}-{len(planned_orders)}", "item": item_id, "qty": round(final_qty, 4), "type": "Purchase", 
                                "start": p_start, "finish": d_str, "supplier": s_name, "lt_days": lt_days
                            })
                            if d_str in mrp_plan[item_id]: mrp_plan[item_id][d_str]['inflow_fresh'] += final_qty
                            
                            unmet -= satisfied_now
                            sup_allocated += satisfied_now
                            steps.append({"action": "Purchase", "msg": f"Ordered {round(final_qty, 4)} from {s_name}", "item": item_id, "qty": round(final_qty, 4)})
                        
                        if sup_allocated >= target_for_sup or unmet <= 0: break

                if unmet > 0:
                    steps.append({"action": "Infeasible", "reason": "Supplier Capacity Shortage", "item": item_id, "qty": round(unmet, 4)})
                    if due_date_str in mrp_plan[item_id]: mrp_plan[item_id][due_date_str]['shortage'] += unmet
        return unmet

    # 5. Demand Resolution Loop
    for _, order in sorted_demand.iterrows():
        item_id = str(order['itemid']).strip().upper()
        trace = {"order_id": str(order.get('scheduleno', 'SO')), "item": item_id, "qty": order['demandqty'], "due": str(order['duedate_clean']), "steps": [], "logs": []}
        resolve(trace['item'], float(order['demandqty']), trace['due'], trace['steps'], trace['logs'], True, 0)
        demand_trace.append(trace)

    # 6. Inventory Roll
    for item in mrp_plan:
        running_stock = 0
        for d in sorted(mrp_plan[item].keys()):
            bucket = mrp_plan[item][d]
            bucket['starting_stock'] = round(running_stock, 4)
            inflows = bucket['inflow_fresh'] + bucket['inflow_onhand']
            outflows = bucket['outflow_dep'] + bucket['outflow_direct']
            net = running_stock + inflows - outflows
            bucket['ending_stock'] = round(max(0, net), 4)
            if net < 0 and bucket['shortage'] == 0:
                bucket['shortage'] = round(abs(net), 4)
            else:
                bucket['shortage'] = round(bucket['shortage'], 4)
            running_stock = bucket['ending_stock']

    return {
        "planned_orders": planned_orders,
        "mrp": mrp_plan,
        "trace": demand_trace,
        "system_logs": system_logs,
        "summary": {"total_planned_orders": len(planned_orders)}
    }