import {
  BarElement,
  CategoryScale,
  Chart as ChartJS,
  Legend,
  LinearScale,
  Title,
  Tooltip,
} from 'chart.js';
import * as R from 'ramda';
import { Bar } from 'react-chartjs-2';

ChartJS.register(CategoryScale, LinearScale, BarElement, Title, Tooltip, Legend);

const options = {
  responsive: true,
  plugins: {
    legend: {
      position: 'top',
    },
    title: {
      display: true,
      text: 'Chart.js Bar Chart',
    },
  },
};

const labels = ['January', 'February', 'March', 'April', 'May', 'June', 'July'];

const data = {
  labels,
  datasets: [
    {
      label: 'Dataset 1',
      data: R.map(() => Math.floor(Math.random() * 100), labels),
      backgroundColor: 'rgba(255, 99, 132, 0.5)',
    },
    {
      label: 'Dataset 2',
      data: R.map(() => Math.floor(Math.random() * 100), labels),
      backgroundColor: 'rgba(53, 162, 235, 0.5)',
    },
  ],
};

export default () => {
  return (
    <div>
      <Bar options={options} data={data} data-testid="e2e-chart-js" />
    </div>
  );
};
