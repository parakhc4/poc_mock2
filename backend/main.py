from fastapi import FastAPI, UploadFile, File, Form, HTTPException
from fastapi.middleware.cors import CORSMiddleware
import pandas as pd
import io
import numpy as np
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
        # 1. Initialize data dictionary
        data = {k: None for k in ['demand', 'items', 'bom', 'routing', 'resource_routing', 'supplies', 'supplier_master']}
        
        mapping = {
            'demand': ['demand', 'sales'], 
            'bom': ['bom', 'bill', 'structure'], 
            'resource_routing': ['resourcerouting', 'resource_routing'],
            'routing': ['routing', 'operations'], 
            'supplier_master': ['suppliermaster', 'supplier_master', 'vendor'],
            'items': ['item', 'article', 'product'], 
            'supplies': ['supplies', 'stock', 'inventory']
        }

        for file in files:
            contents = await file.read()
            filename = file.filename.lower()

            if filename.endswith(('.xlsx', '.xls')):
                xls = pd.read_excel(io.BytesIO(contents), sheet_name=None)
                for sheet_name, df in xls.items():
                    clean_sheet = sheet_name.lower().replace(" ", "").replace("_", "").replace("-", "")
                    matched_key = None
                    for key, patterns in mapping.items():
                        if any(p in clean_sheet for p in patterns):
                            matched_key = key
                            break
                    if matched_key:
                        data[matched_key] = df.dropna(how='all').reset_index(drop=True)

            else:
                clean_filename = filename.replace(" ", "").replace("_", "").replace("-", "")
                for key, patterns in mapping.items():
                    if any(p in clean_filename for p in patterns):
                        df = pd.read_csv(io.BytesIO(contents))
                        data[key] = df.dropna(how='all')
                        break

        # 2. Date Setup
        sim_start = pd.to_datetime(start_date).date() if start_date else datetime(2025, 12, 1).date()

        # 3. Run Solver
        results = run_solver(data, horizon, sim_start, is_constrained, build_ahead)
        
        # 4. JSON Compliance: Replace NaN with None (null in JSON)
        # We attach raw_data so the Network Graph can map items NOT in the demand list
        results["raw_data"] = {
            "bom": data['bom'].replace({np.nan: None}).to_dict('records') if data['bom'] is not None else [],
            "supplier_master": data['supplier_master'].replace({np.nan: None}).to_dict('records') if data['supplier_master'] is not None else [],
            "items": data['items'].replace({np.nan: None}).to_dict('records') if data['items'] is not None else []
        }
        
        return results

    except Exception as e:
        raise HTTPException(status_code=500, detail=str(e))

if __name__ == "__main__":
    import uvicorn
    uvicorn.run(app, host="0.0.0.0", port=8000)