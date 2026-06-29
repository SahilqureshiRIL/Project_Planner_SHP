import pandas as pd
from pathlib import Path
base = Path('data')
for name in ['manpower_resources.xlsx','material_logistics.xlsx','progress_history.xlsx']:
    path = base / name
    print('\n===', name, '===')
    xls = pd.ExcelFile(path)
    print('sheets:', xls.sheet_names)
    for s in xls.sheet_names:
        df = pd.read_excel(path, sheet_name=s)
        print('\n[Sheet]', s, 'shape=', df.shape)
        print(df.head(5).to_string(index=False))
        print('columns:', list(df.columns))
        print('---')
