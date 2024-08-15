import 'ag-grid-community/styles/ag-grid.css';
import 'ag-grid-community/styles/ag-theme-alpine.css';
import { AgGridReact } from 'ag-grid-react';
import { useState } from 'react';
import './agGrid.css';


export const AgGridDemo = ({ }) => {
  const [rowData] = useState([
    { make: 'Toyota', model: 'Celica', price: 35000 },
    { make: 'Ford', model: 'Mondeo', price: 32000 },
    { make: 'Porsche', model: 'Boxter', price: 72000 },
  ]);

  const [columnDefs] = useState([{ field: 'make' }, { field: 'model' }, { field: 'price' }]);

  return (
    <div className="App">
      <div style={{ display: 'flex', flexDirection: 'row' }}>
        <div
          id="grid1"
          className="ag-theme-alpine"
          style={{ height: 400, width: 600, margin: '20px' }}
        >
          <AgGridReact rowData={rowData} columnDefs={columnDefs}></AgGridReact>
        </div>
        <div
          id="grid2"
          className="ag-theme-alpine"
          style={{ height: 400, width: 600, margin: '20px' }}
        >
          <AgGridReact rowData={rowData} columnDefs={columnDefs}></AgGridReact>
        </div>
      </div>
    </div>
  );
};