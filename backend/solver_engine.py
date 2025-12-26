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

def run_solver(data, horizon, start_date, is_constrained, build_ahead):
    """
    Main engine to calculate MRP, planned orders, and detailed demand traces.
    """
    is_constrained = str(is_constrained).lower() == 'true'
    build_ahead = str(build_ahead).lower() == 'true'

    system_logs = []
    def sys_log(msg):
        system_logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")

    sys_log(f"Initializing Solver Engine (Start: {start_date}, Constrained: {is_constrained})")
    
    # 1. Normalize and Standardize Data
    items = normalize_df(data.get('items'))
    demand = normalize_df(data.get('demand'))
    bom = normalize_df(data.get('bom'))
    routing_master = normalize_df(data.get('routing'))
    res_routing = normalize_df(data.get('resource_routing'))
    supplies = normalize_df(data.get('supplies'))
    supplier_master = normalize_df(data.get('supplier_master'))
    
    # Sanitize IDs: Trim whitespace and convert to uppercase for reliable matching
    # This ensures "M-MI-281" matches regardless of leading/trailing spaces in data.
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
    
    # Resource Capacity
    transient_resource_capacity = {}
    if res_routing is not None:
        for _, row in res_routing.iterrows():
            res_id = str(row['resourceid'])
            if res_id not in transient_resource_capacity:
                daily_hours = (pd.to_numeric(row.get('dailycapacity', 0)) or 0) * (pd.to_numeric(row.get('noofmachines', 1)) or 1)
                transient_resource_capacity[res_id] = {d: daily_hours for d in dates_list}

    # Supplier Capacity per Item
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
        indent = "  " * depth
        log_list.append(f"{indent}>>> Resolving: {item_id} | Qty: {qty} | Due: {due_date_str}")
        
        init_mrp(item_id)
        if due_date_str in mrp_plan[item_id]:
            if is_direct: mrp_plan[item_id][due_date_str]['outflow_direct'] += qty
            else: mrp_plan[item_id][due_date_str]['outflow_dep'] += qty
        
        item_info = items[items['itemid'] == item_id] if items is not None else pd.DataFrame()
        if item_info.empty:
            log_list.append(f"{indent}ERROR: {item_id} not found in Item Master.")
            steps.append({"action": "Infeasible", "reason": "Missing Master Data", "item": item_id})
            return qty
        
        item_row = item_info.iloc[0]
        unmet = qty
        
        # A. Stock Consumption
        stock = transient_stock.get(item_id, 0)
        if stock > 0:
            consumed = min(unmet, stock)
            transient_stock[item_id] -= consumed
            unmet -= consumed
            log_list.append(f"{indent}Stock Action: Consumed {consumed}. Remaining unmet: {unmet}")
            steps.append({"action": "Stock", "msg": f"Consumed {consumed} units", "qty": consumed, "item": item_id})
        
        if unmet <= 0:
            log_list.append(f"{indent}Requirement satisfied by existing stock.")
            return 0

        # B. Manufacturing vs Purchase Policy
        mb_raw = str(item_row.get('makebuy', 'buy')).lower()
        log_list.append(f"{indent}Policy: {mb_raw.upper()}")
        is_make = 'make' in mb_raw or 'both' in mb_raw
        
        if is_make:
            # 1. Lead Time and Start Date
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
            log_list.append(f"{indent}Lead Time: {lt_days} days. Target Start: {req_start_str}")

            if req_start_dt.date() < start_date:
                log_list.append(f"{indent}WARNING: Lead Time Violation (Required start before simulation).")
                steps.append({"action": "Infeasible", "reason": "RCA Lead Time Violation", "item": item_id, "needed_start": req_start_str})

            # 2. EXPLODE BOM: Recursion continues regardless of capacity bottlenecks
            comps = bom[bom['parentid'] == item_id] if bom is not None else pd.DataFrame()
            if not comps.empty:
                log_list.append(f"{indent}BOM Explosion: Found {len(comps)} unique components.")
                for _, c_row in comps.iterrows():
                    c_id = str(c_row['childid'])
                    c_qty = unmet * pd.to_numeric(c_row.get('qtyper', 1))
                    log_list.append(f"{indent}-> Dependent requirement: {c_id} (Qty: {c_qty})")
                    resolve(c_id, c_qty, req_start_str, steps, log_list, False, depth + 1)
            else:
                log_list.append(f"{indent}BOM: No components found for this item.")

            # 3. Capacity Scheduling
            routing = res_routing[res_routing['item'] == item_id] if res_routing is not None else pd.DataFrame()
            if not routing.empty and is_constrained:
                route_row = routing.iloc[0]
                res_id = str(route_row['resourceid'])
                cons_raw = pd.to_numeric(route_row.get('capacityconsumedper', 1))
                needed_cap_hrs = (unmet * cons_raw) / 3600 if cons_raw >= 1 else unmet * cons_raw
                log_list.append(f"{indent}Scheduling Request: {res_id} (Needs {round(needed_cap_hrs, 2)} hrs)")
                
                actual_start_dt = req_start_dt
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
                        log_list.append(f"{indent}Capacity Found: {d_str} has {round(avail, 2)} hrs free.")
                        break
                
                if found_capacity:
                    actual_str = actual_start_dt.strftime('%Y-%m-%d')
                    transient_resource_capacity[res_id][actual_str] -= needed_cap_hrs
                    planned_orders.append({
                        "id": f"PO-{item_id}-{len(planned_orders)}", "item": item_id, "qty": unmet, "type": "Production", 
                        "start": actual_str, "finish": due_date_str, "res": res_id, "lt_days": lt_days, "supplier": "Internal"
                    })
                    if due_date_str in mrp_plan[item_id]: mrp_plan[item_id][due_date_str]['inflow_fresh'] += unmet
                    steps.append({"action": "Production", "msg": f"Scheduled on {res_id}", "item": item_id, "qty": unmet})
                    unmet = 0
                else:
                    log_list.append(f"{indent}SHORTAGE: Capacity Bottleneck on {res_id}.")
                    steps.append({"action": "Infeasible", "reason": "Capacity Bottleneck", "item": item_id, "resource": res_id})
                    if due_date_str in mrp_plan[item_id]: mrp_plan[item_id][due_date_str]['shortage'] += unmet
            else:
                # Unconstrained / No Routing
                log_list.append(f"{indent}Action: Planning Unconstrained Production.")
                planned_orders.append({"id": f"PO-{item_id}-{len(planned_orders)}", "item": item_id, "qty": unmet, "type": "Production", "start": req_start_str, "finish": due_date_str, "lt_days": lt_days, "supplier": "Internal"})
                if due_date_str in mrp_plan[item_id]: mrp_plan[item_id][due_date_str]['inflow_fresh'] += unmet
                steps.append({"action": "Production", "msg": "Scheduled (Unconstrained)", "item": item_id, "qty": unmet})
                unmet = 0
        else:
            # 4. Purchasing Logic: Follows Share Percent and respects Supplier Capacity
            log_list.append(f"{indent}Buy Logic: Identifying suppliers for {item_id}")
            item_suppliers = supplier_master[supplier_master['itemid'] == item_id] if supplier_master is not None else pd.DataFrame()
            
            if item_suppliers.empty:
                log_list.append(f"{indent}Warning: No supplier data found. Using default lead time.")
                lt_days = int(pd.to_numeric(item_row.get('leadtimebuy', 7), errors='coerce'))
                req_start_str = (datetime.strptime(due_date_str, '%Y-%m-%d') - timedelta(days=lt_days)).strftime('%Y-%m-%d')
                planned_orders.append({"id": f"PUR-{item_id}-{len(planned_orders)}", "item": item_id, "qty": unmet, "type": "Purchase", "start": req_start_str, "finish": due_date_str, "lt_days": lt_days, "supplier": "Unknown"})
                if due_date_str in mrp_plan[item_id]: mrp_plan[item_id][due_date_str]['inflow_fresh'] += unmet
                steps.append({"action": "Purchase", "msg": "Ordered (Default Supplier)", "item": item_id, "qty": unmet})
                unmet = 0
            else:
                # Sort by share percentage
                sorted_sups = item_suppliers.sort_values(by='sharepercent', ascending=False)
                original_unmet = unmet
                
                for _, s_row in sorted_sups.iterrows():
                    if unmet <= 0: break
                    
                    s_id = str(s_row.get('supplierid', s_row.get('suppliername', 'Unknown')))
                    s_name = str(s_row.get('suppliername', s_id))
                    share = pd.to_numeric(s_row.get('sharepercent', 1.0), errors='coerce')
                    lt_days = int(pd.to_numeric(s_row.get('leadtimedays', 7), errors='coerce'))
                    cap_key = f"{s_id}_{item_id}"
                    
                    # Target qty based on supplier share
                    target_for_sup = original_unmet * share
                    log_list.append(f"{indent}Supplier {s_name}: Allocated target {target_for_sup} based on {int(share*100)}% share.")
                    
                    sup_allocated = 0
                    lookback = 15 if build_ahead else 1
                    curr_dt = datetime.strptime(due_date_str, '%Y-%m-%d')
                    
                    for lb in range(lookback):
                        d_str = (curr_dt - timedelta(days=lb)).strftime('%Y-%m-%d')
                        if d_str not in transient_supplier_capacity.get(cap_key, {}): continue
                        
                        avail = transient_supplier_capacity[cap_key][d_str]
                        can_take = min(target_for_sup - sup_allocated, unmet, avail)
                        
                        if can_take > 0:
                            transient_supplier_capacity[cap_key][d_str] -= can_take
                            sup_allocated += can_take
                            unmet -= can_take
                            p_start = (datetime.strptime(d_str, '%Y-%m-%d') - timedelta(days=lt_days)).strftime('%Y-%m-%d')
                            
                            planned_orders.append({
                                "id": f"PUR-{item_id}-{len(planned_orders)}", "item": item_id, "qty": can_take, "type": "Purchase", 
                                "start": p_start, "finish": d_str, "supplier": s_name, "lt_days": lt_days
                            })
                            if d_str in mrp_plan[item_id]: mrp_plan[item_id][d_str]['inflow_fresh'] += can_take
                            log_list.append(f"{indent}  -> Secured {can_take} from {s_name} on {d_str}")
                        
                        if sup_allocated >= target_for_sup or unmet <= 0: break

                if unmet > 0:
                    log_list.append(f"{indent}SHORTAGE: Supplier capacity exhausted for {item_id}.")
                    steps.append({"action": "Infeasible", "reason": "Supplier Capacity Shortage", "item": item_id, "qty": unmet})
                    if due_date_str in mrp_plan[item_id]: mrp_plan[item_id][due_date_str]['shortage'] += unmet
                    
        return unmet

    # 5. Main Loop
    for _, order in sorted_demand.iterrows():
        order_logs = []
        item_id = str(order['itemid']).strip().upper()
        trace = {
            "order_id": str(order.get('scheduleno', 'SO')), 
            "item": item_id, 
            "qty": order['demandqty'], 
            "due": str(order['duedate_clean']), 
            "steps": [], 
            "logs": order_logs
        }
        resolve(trace['item'], float(order['demandqty']), trace['due'], trace['steps'], order_logs, True, 0)
        demand_trace.append(trace)

    # 6. Inventory Roll
    for item in mrp_plan:
        running_stock = 0
        for d in sorted(mrp_plan[item].keys()):
            bucket = mrp_plan[item][d]
            bucket['starting_stock'] = running_stock
            inflows = bucket['inflow_fresh'] + bucket['inflow_onhand']
            outflows = bucket['outflow_dep'] + bucket['outflow_direct']
            net = running_stock + inflows - outflows
            bucket['ending_stock'] = max(0, net)
            if net < 0 and bucket['shortage'] == 0:
                bucket['shortage'] = abs(net)
            running_stock = bucket['ending_stock']

    return {
        "planned_orders": planned_orders,
        "mrp": mrp_plan,
        "trace": demand_trace,
        "system_logs": system_logs,
        "summary": {"total_planned_orders": len(planned_orders)}
    }