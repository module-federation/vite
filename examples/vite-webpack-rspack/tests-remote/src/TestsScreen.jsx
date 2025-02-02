import ReactChartJs from './ReactChartJs';
import ReactDropzone from './ReactDropzone';
import ReactEasyCrop from './ReactEasyCrop';

const TestsScreen = () => {
  return (
    <section>
      <h1 className="text-2xl font-bold text-center">Tests Screen</h1>
      <p className="text-center text-gray-500">
        This screen is for testing Module Federation and it's integration with external libraries.
      </p>
      <div className="grid grid-cols-3 gap-4 pt-2">
        <ReactChartJs />
        <ReactDropzone />
        <ReactEasyCrop />
      </div>
    </section>
  );
};

export default TestsScreen;
