from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import pandas as pd
import io
from datetime import datetime
try:
    from solver_engine import run_solver 
except ImportError:
    from .solver_engine import run_solver

app = FastAPI()

app.add_middleware(
    CORSMiddleware,
    allow_origins=["*"],
    allow_methods=["*"],
    allow_headers=["*"],
)

@app.post("/solve")
async def solve(
    horizon: int = Form(30),
    start_date: str = Form(None),
    is_constrained: bool = Form(True),
    build_ahead: bool = Form(True),
    files: list[UploadFile] = File(...)
):
    try:
        print(f"--- INCOMING REQUEST: {len(files)} FILES ---")
        
        # 1. Initialize data dictionary
        data = {k: None for k in ['demand', 'items', 'bom', 'routing', 'resource_routing', 'supplies', 'supplier_master']}
        
        # Mapping patterns to find the right sheet/file
        mapping = {
            'demand': ['demand', 'sales'], 
            'items': ['item', 'article', 'product', 'master'], 
            'bom': ['bom', 'bill', 'structure'], 
            'routing': ['routing', 'operations'], 
            'resource_routing': ['resource_routing', 'resourcerouting'],
            'supplies': ['supplies', 'stock', 'inventory'], 
            'supplier_master': ['supplier_master', 'suppliermaster', 'vendor']
        }

        for file in files:
            contents = await file.read()
            filename = file.filename.lower()
            print(f"Processing Upload: {filename}")

            # --- LOGIC FOR EXCEL FILES ---
            if filename.endswith(('.xlsx', '.xls')):
                try:
                    # Load the entire workbook
                    xls = pd.read_excel(io.BytesIO(contents), sheet_name=None)
                    print(f"  -> Detected Excel with sheets: {list(xls.keys())}")
                    
                    # Iterate through every sheet in the workbook
                    for sheet_name, df in xls.items():
                        clean_sheet = sheet_name.lower().strip()
                        matched_key = None
                        
                        # Find which data bucket this sheet belongs to
                        for key, patterns in mapping.items():
                            if any(p in clean_sheet for p in patterns):
                                matched_key = key
                                break
                        
                        if matched_key:
                            # Clean the data: drop empty rows
                            data[matched_key] = df.dropna(how='all').reset_index(drop=True)
                            print(f"    -> Sheet '{sheet_name}' mapped to '{matched_key}' ({len(df)} rows)")
                except Exception as e:
                    print(f"  -> ERROR parsing Excel: {e}")

            # --- LOGIC FOR CSV FILES (Fallback) ---
            else:
                for key, patterns in mapping.items():
                    if any(p in filename for p in patterns):
                        try:
                            df = pd.read_csv(io.BytesIO(contents))
                            data[key] = df.dropna(how='all')
                            print(f"  -> CSV '{filename}' mapped to '{key}'")
                        except Exception as e:
                            print(f"  -> ERROR reading CSV: {e}")

        # 2. Date Setup (Default to past date to allow lead times)
        sim_start = pd.to_datetime(start_date).date() if start_date else datetime(2025, 12, 1).date()
        print(f"Simulation Start: {sim_start}")

        # 3. Run Solver
        results = run_solver(data, horizon, sim_start, is_constrained, build_ahead)
        
        if results is None:
            raise ValueError("Solver returned None.")

        return {
            "planned_orders": results.get('planned_orders', []),
            "mrp": results.get('mrp', {}),
            "trace": results.get('trace', []),
            "system_logs": results.get('system_logs', []),
            "summary": results.get('summary', {"total_planned_orders": 0})
        }

    except Exception as e:
        print(f"CRITICAL SERVER ERROR: {str(e)}") 
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)