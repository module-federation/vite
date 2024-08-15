import { css } from '@emotion/react';
import { createTheme, Paper, StyledEngineProvider, ThemeProvider, Typography } from '@mui/material';
import Button from '@mui/material/Button';
import React from 'react';
import styles from './Mui5Widget.module.css';

const FooterClasses = {
    root: {
        padding: '10px',
    },
};

// Emotion
const emotionClass = css`
  background-color: orange;
  color: red;
  border: 1px solid black;
  font-size: 20px;
  margin: 10px;
`;

// Create Theme
const theme = createTheme({
    palette: {
        background: {
            paper: '#FF0000',
        },
        text: {
            primary: '#173A5E',
            secondary: '#46505A',
        },
        action: {
            active: '#001E3C',
        },
    },
    components: {
        // Name of the component
        MuiButtonBase: {
            defaultProps: {
                // The props to change the default for.
                disableRipple: true, // No more ripple, on the whole application 💣!
            },
        },
        MuiButton: {
            styleOverrides: {
                // Name of the slot
                root: {
                    // Some CSS
                    fontSize: '1rem',
                    fontFamily: 'Arial',
                    margin: 10,
                    border: '2px solid yellow',
                },
            },
        },
    },
});

export const MuiDemo = ({ }) => {
    return (
        <StyledEngineProvider injectFirst>
            <div className={styles.container}>
                <div>
                    <Button variant="contained">Button OutSide Theme</Button>
                </div>
                <div>
                    <ThemeProvider theme={theme}>
                        <Button variant="contained">Button Theme Styled </Button>
                    </ThemeProvider>
                </div>
                <div>
                    <ThemeProvider theme={theme}>
                        <Button variant="contained" sx={{ bgcolor: 'background.paper' }}>
                            Button Theme Styled overriden
                        </Button>
                    </ThemeProvider>
                </div>
                <div>
                    <Button variant="contained" css={emotionClass}>
                        Button Emotion Styled
                    </Button>
                </div>

                <div>
                    <Button variant="contained" className={styles.myButton}>
                        Button CSS Module Styled
                    </Button>
                </div>

                <Paper component="footer" sx={FooterClasses.root} elevation={3} id="footer-paper-container">
                    <Typography variant="subtitle1">Text inside typography</Typography>
                </Paper>
            </div>
        </StyledEngineProvider>
    );
};
