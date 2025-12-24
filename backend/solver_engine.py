import pandas as pd
import numpy as np
from datetime import datetime, timedelta

def normalize_df(df):
    if df is None: return None
    df_copy = df.copy()
    df_copy.columns = [str(c).lower().replace(" ", "").replace("_", "").replace("-", "") for c in df_copy.columns]
    return df_copy.dropna(how='all').reset_index(drop=True)

def get_col(df, *options):
    if df is None: return None
    norm_options = [o.lower().replace(" ", "").replace("_", "").replace("-", "") for o in options]
    for col in df.columns:
        normalized_col = str(col).lower().replace(" ", "").replace("_", "").replace("-", "")
        if normalized_col in norm_options:
            return col
    return None

def run_solver(data, horizon, start_date, is_constrained, build_ahead):
    # Ensure booleans are actually boolean
    is_constrained = str(is_constrained).lower() == 'true'
    build_ahead = str(build_ahead).lower() == 'true'

    system_logs = []
    def sys_log(msg):
        system_logs.append(f"[{datetime.now().strftime('%H:%M:%S')}] {msg}")

    sys_log(f"Initializing Solver Engine (Start: {start_date}, Constrained: {is_constrained}, BuildAhead: {build_ahead})")
    
    # 1. Normalize
    items = normalize_df(data.get('items'))
    demand = normalize_df(data.get('demand'))
    bom = normalize_df(data.get('bom'))
    routing_master = normalize_df(data.get('routing'))
    res_routing = normalize_df(data.get('resource_routing'))
    supplies = normalize_df(data.get('supplies'))
    supplier_master = normalize_df(data.get('supplier_master'))
    
    transient_stock = {}
    initial_onhand, initial_wip, initial_supplier_stock = {}, {}, {}
    
    # 2. Init Inventory
    item_col = get_col(supplies, "itemid", "itemcode", "item")
    if item_col and supplies is not None:
        for _, row in supplies.iterrows():
            item_id = str(row[item_col]).strip()
            oh = pd.to_numeric(row.get('fg', 0), errors='coerce') or 0
            wp = pd.to_numeric(row.get('wip', 0), errors='coerce') or 0
            sup = pd.to_numeric(row.get('supplier', 0), errors='coerce') or 0
            other = sum([pd.to_numeric(row[c], errors='coerce') or 0 for c in supplies.columns if 'rework' in str(c).lower()])
            
            initial_onhand[item_id] = oh + other
            initial_wip[item_id] = wp
            initial_supplier_stock[item_id] = sup
            transient_stock[item_id] = initial_onhand[item_id] + initial_wip[item_id] + initial_supplier_stock[item_id]
    
    # 3. Init Capacities
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
            item_id = str(row['itemid']).strip()
            cap_key = f"{s_id}_{item_id}"
            if cap_key not in transient_supplier_capacity:
                daily_qty = pd.to_numeric(row.get('suppliercapacityperday', 999999), errors='coerce') or 999999
                transient_supplier_capacity[cap_key] = {d: daily_qty for d in dates_list}

    # 4. Process Demand
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

    def resolve(item_id, qty, due_date_str, steps, log_list, is_direct=False):
        init_mrp(item_id)
        if due_date_str in mrp_plan[item_id]:
            if is_direct: mrp_plan[item_id][due_date_str]['outflow_direct'] += qty
            else: mrp_plan[item_id][due_date_str]['outflow_dep'] += qty
        
        item_info = items[items['itemid'].astype(str) == item_id] if items is not None else pd.DataFrame()
        if item_info.empty:
            steps.append({"action": "Infeasible", "reason": "Missing Master Data", "item": item_id})
            return qty
        
        item_row = item_info.iloc[0]
        unmet = qty
        
        # A. Stock
        stock = transient_stock.get(item_id, 0)
        if stock > 0:
            consumed = min(unmet, stock)
            transient_stock[item_id] -= consumed
            unmet -= consumed
            steps.append({"action": "Stock", "msg": f"Consumed {consumed} units", "qty": consumed, "item": item_id})
        
        if unmet <= 0: return 0

        # B. Make vs Buy
        make_buy = str(item_row.get('makebuy', 'buy')).lower()
        is_make = 'make' in make_buy
        
        if is_make:
            # Lead Time Calc
            base_sec = 0
            if routing_master is not None:
                item_routing = routing_master[routing_master['item'].astype(str) == item_id]
                if not item_routing.empty:
                    base_sec = pd.to_numeric(item_routing.iloc[0].get('cycletime', 0), errors='coerce') or 0
            if base_sec == 0:
                base_sec = pd.to_numeric(item_row.get('leadtimemakeseconds', item_row.get('leadtimemake', 0)), errors='coerce') or 0

            needed_hrs = (unmet * base_sec) / 3600
            lt_days = int(needed_hrs // 24)
        else:
            lt_days = int(pd.to_numeric(item_row.get('leadtimebuy', 7), errors='coerce'))
        
        lt_days = max(0, lt_days)
        req_start_dt = datetime.strptime(due_date_str, '%Y-%m-%d') - timedelta(days=lt_days)
        req_start_str = req_start_dt.strftime('%Y-%m-%d')

        if req_start_dt.date() < start_date:
            steps.append({
                "action": "Infeasible", 
                "reason": "RCA Lead Time Violation", 
                "item": item_id, 
                "needed_start": req_start_str
            })
            if due_date_str in mrp_plan[item_id]: mrp_plan[item_id][due_date_str]['shortage'] += unmet
            return unmet

        if is_make:
            # Production
            routing = res_routing[res_routing['item'].astype(str) == item_id] if res_routing is not None else pd.DataFrame()
            if not routing.empty and is_constrained:
                # Constrained Logic
                route_row = routing.iloc[0]
                res_id = str(route_row['resourceid'])
                cons_raw = pd.to_numeric(route_row.get('capacityconsumedper', 1))
                needed_cap_hrs = (unmet * cons_raw) / 3600 if cons_raw >= 1 else unmet * cons_raw
                
                actual_start_dt = req_start_dt
                actual_str = actual_start_dt.strftime('%Y-%m-%d')
                
                avail_hrs = transient_resource_capacity.get(res_id, {}).get(actual_str, 0)
                
                if avail_hrs < needed_cap_hrs and build_ahead:
                    for lb in range(1, 15):
                        check_dt = req_start_dt - timedelta(days=lb)
                        if check_dt.date() < start_date: break
                        if transient_resource_capacity.get(res_id, {}).get(check_dt.strftime('%Y-%m-%d'), 0) >= needed_cap_hrs:
                            actual_start_dt = check_dt
                            actual_str = actual_start_dt.strftime('%Y-%m-%d')
                            avail_hrs = transient_resource_capacity[res_id][actual_str]
                            break
                
                if transient_resource_capacity.get(res_id, {}).get(actual_str, 0) >= needed_cap_hrs:
                    transient_resource_capacity[res_id][actual_str] -= needed_cap_hrs
                    planned_orders.append({
                        "id": f"PO-{item_id}-{len(planned_orders)}", "item": item_id, "qty": unmet, "type": "Production", 
                        "start": actual_str, "finish": due_date_str, "res": res_id, "lt_days": lt_days, "supplier": "Internal"
                    })
                    if due_date_str in mrp_plan[item_id]: mrp_plan[item_id][due_date_str]['inflow_fresh'] += unmet
                    
                    steps.append({"action": "Production", "msg": f"Scheduled on {res_id}", "item": item_id, "qty": unmet, "resource": res_id})

                    comps = bom[bom['parentid'].astype(str) == item_id] if bom is not None else pd.DataFrame()
                    for _, c_row in comps.iterrows():
                        c_qty = unmet * pd.to_numeric(c_row.get('qtyper', 1))
                        resolve(str(c_row['childid']), c_qty, actual_str, steps, log_list, False)
                    unmet = 0
                else:
                    steps.append({"action": "Infeasible", "reason": "Capacity Bottleneck", "item": item_id, "resource": res_id, "avail": avail_hrs})
                    if due_date_str in mrp_plan[item_id]: mrp_plan[item_id][due_date_str]['shortage'] += unmet
            else:
                # Unconstrained / No Routing
                planned_orders.append({"id": f"PO-{item_id}-{len(planned_orders)}", "item": item_id, "qty": unmet, "type": "Production", "start": req_start_str, "finish": due_date_str, "lt_days": lt_days, "supplier": "Internal"})
                if due_date_str in mrp_plan[item_id]: mrp_plan[item_id][due_date_str]['inflow_fresh'] += unmet
                
                steps.append({"action": "Production", "msg": "Scheduled (Unconstrained)", "item": item_id, "qty": unmet})

                if bom is not None:
                    bom[bom['parentid'].astype(str) == item_id].apply(lambda x: resolve(str(x['childid']), unmet * pd.to_numeric(x['qtyper']), req_start_str, steps, log_list, False), axis=1)
                unmet = 0
        else:
            # Buy Logic
            item_suppliers = supplier_master[supplier_master['itemid'].astype(str) == item_id] if supplier_master is not None else pd.DataFrame()
            
            if item_suppliers.empty:
                planned_orders.append({"id": f"PUR-{item_id}-{len(planned_orders)}", "item": item_id, "qty": unmet, "type": "Purchase", "start": req_start_str, "finish": due_date_str, "lt_days": lt_days, "supplier": "Unknown"})
                if due_date_str in mrp_plan[item_id]: mrp_plan[item_id][due_date_str]['inflow_fresh'] += unmet
                steps.append({"action": "Purchase", "msg": "Ordered (Unknown Supplier)", "item": item_id, "qty": unmet})
                unmet = 0
            else:
                sorted_sups = item_suppliers.sort_values(by='sharepercent', ascending=False)
                remaining_to_plan = unmet
                
                for _, s_row in sorted_sups.iterrows():
                    if remaining_to_plan <= 0: break
                    s_id = str(s_row.get('supplierid', s_row.get('suppliername')))
                    s_name = str(s_row.get('suppliername', s_id))
                    share = pd.to_numeric(s_row.get('sharepercent', 0), errors='coerce') or 0
                    
                    target_for_this_sup = unmet * share
                    if target_for_this_sup <= 0: continue
                    
                    lt_days_s = int(pd.to_numeric(s_row.get('leadtimedays', 7), errors='coerce'))
                    cap_key = f"{s_id}_{item_id}"
                    
                    sup_allocated = 0
                    curr_date_dt = datetime.strptime(due_date_str, '%Y-%m-%d')
                    days_looked = 0
                    max_lookback = 15 if build_ahead else 1
                    
                    while days_looked < max_lookback and sup_allocated < target_for_this_sup and remaining_to_plan > 0:
                        if curr_date_dt.date() < start_date: break
                        
                        d_str = curr_date_dt.strftime('%Y-%m-%d')
                        avail = transient_supplier_capacity.get(cap_key, {}).get(d_str, 0)
                        
                        can_take = min(target_for_this_sup - sup_allocated, remaining_to_plan, avail)
                        
                        if can_take > 0:
                            transient_supplier_capacity[cap_key][d_str] -= can_take
                            sup_allocated += can_take
                            remaining_to_plan -= can_take
                            
                            release_dt_str = (datetime.strptime(d_str, '%Y-%m-%d') - timedelta(days=lt_days_s)).strftime('%Y-%m-%d')
                            planned_orders.append({
                                "id": f"PUR-{item_id}-{s_id}-{len(planned_orders)}", "item": item_id, "qty": can_take, "type": "Purchase", 
                                "start": release_dt_str, "finish": d_str, "lt_days": lt_days_s, "supplier": s_name
                            })
                            if d_str in mrp_plan[item_id]:
                                mrp_plan[item_id][d_str]['inflow_fresh'] += can_take
                            
                            steps.append({"action": "Purchase", "msg": f"Ordered from {s_name}", "item": item_id, "qty": can_take, "supplier": s_name, "date": release_dt_str})
                        
                        curr_date_dt -= timedelta(days=1)
                        days_looked += 1

                if remaining_to_plan > 0:
                    steps.append({"action": "Infeasible", "reason": "Supplier Capacity Constraint", "item": item_id, "needed": remaining_to_plan})
                    if due_date_str in mrp_plan[item_id]: mrp_plan[item_id][due_date_str]['shortage'] += remaining_to_plan
                
                unmet = remaining_to_plan
                    
        return unmet

    for _, order in sorted_demand.iterrows():
        order_logs = []
        if pd.isna(order.get('itemid')): continue
        trace = {
            "order_id": str(order.get('scheduleno', 'SO')), 
            "item": str(order['itemid']), 
            "qty": order['demandqty'], 
            "due": str(order['duedate_clean']) if not pd.isna(order['duedate_clean']) else "N/A", 
            "steps": [], 
            "logs": order_logs
        }
        resolve(trace['item'], float(order['demandqty']), trace['due'], trace['steps'], order_logs, True)
        demand_trace.append(trace)

    # 5. Inventory Roll
    for item in mrp_plan:
        running_stock = 0
        for d in sorted(mrp_plan[item].keys()):
            bucket = mrp_plan[item][d]
            bucket['starting_stock'] = running_stock
            inflows = bucket['inflow_fresh'] + bucket['inflow_wip'] + bucket['inflow_onhand'] + bucket['inflow_supplier']
            outflows = bucket['outflow_dep'] + bucket['outflow_direct']
            net = running_stock + inflows - outflows
            bucket['ending_stock'] = max(0, net)
            if net < 0 and bucket['shortage'] == 0:
                bucket['shortage'] = abs(net)
            running_stock = bucket['ending_stock']

    return {
        "planned_orders": pd.DataFrame(planned_orders).to_dict(orient='records') if planned_orders else [],
        "mrp": mrp_plan,
        "trace": demand_trace,
        "system_logs": system_logs,
        "summary": {
            "total_planned_orders": len(planned_orders),
            "shortage_count": sum(1 for item in mrp_plan for d in mrp_plan[item] if mrp_plan[item][d].get('shortage', 0) > 0)
        }
    }