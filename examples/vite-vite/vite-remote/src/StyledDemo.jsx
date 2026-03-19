import React from 'react';
import * as styledComponents from 'styled-components';

const styled =
  styledComponents.default?.default ||
  styledComponents.default?.styled ||
  styledComponents.default ||
  styledComponents.styled ||
  styledComponents;

export default styled(function ({ className }) {
    return <div className={className}>Styled components</div>;
})`
  background: salmon;
  padding: 30px;
`;
